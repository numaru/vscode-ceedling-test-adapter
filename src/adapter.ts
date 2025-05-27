import { Mutex } from 'async-mutex';
import child_process from 'child_process';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import semver from 'semver';
import stripAnsi from 'strip-ansi';
import tree_kill from 'tree-kill';
import util from 'util';
import vscode from 'vscode';
import {
    TestAdapter,
    TestEvent,
    TestInfo,
    TestLoadFinishedEvent,
    TestLoadStartedEvent,
    TestRunFinishedEvent,
    TestRunStartedEvent,
    TestSuiteEvent,
    TestSuiteInfo
} from 'vscode-test-adapter-api';
import xml2js from 'xml2js';
import { Logger } from './logger';
import { ProblemMatcher, ProblemMatchingPattern } from './problemMatcher';
import deepmerge from 'deepmerge';

type ProjectData = {
    projectPath: string,
    ymlFileName: any,
    absPath: string,
    debugLaunchConfig: string,
    files: {
        assembly?: string[],
        header?: string[],
        source?: string[],
        test?: string[],
    }
}

type ProjectConfig = {
    path: string,
    debugLaunchConfig: string,
    name?: string,
}

interface ExtendedTestSuiteInfo extends TestSuiteInfo {
    projectKey: string | undefined,
    isProjectRoot: boolean
}

interface ExtendedTestInfo extends TestInfo {
    projectKey: string
}

export class CeedlingAdapter implements TestAdapter {

    private ceedlingVersionChecked = false;
    private isOldCeedlingVersion = true;
    private disposables: { dispose(): void }[] = [];

    private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
    private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
    private readonly autorunEmitter = new vscode.EventEmitter<void>();

    private readonly problemMatcher = new ProblemMatcher();

    private ceedlingProcess: child_process.ChildProcess | undefined;
    private debugTestExecutable: string = '';

    //mapped to the project path
    private functionRegexps: Record<string, RegExp | undefined> = {};
    private fileLabelRegexps: Record<string, RegExp | undefined> = {};
    private testLabelRegexps: Record<string, RegExp | undefined> = {};
    private buildDirectories: Record<string, string> = {};
    private reportFilenames: Record<string, string> = {};

    private watchedFileForAutorunList: string[] = [];
    private watchedFileForReloadList: string[] = [];

    private testSuiteInfo: ExtendedTestSuiteInfo = {
        type: 'suite',
        id: 'root',
        label: 'Ceedling',
        isProjectRoot: false,
        projectKey: undefined,
        children: []
    };

    private isCanceled: boolean = false;
    private isPrettyTestLabelEnable: boolean = false;
    private isPrettyTestFileLabelEnable: boolean = false;
    private ceedlingMutex: Mutex = new Mutex();

    private projectData: Record<string, ProjectData> = {};

    private debugSessionDisposable: vscode.Disposable | undefined;

    get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
        return this.testsEmitter.event;
    }

    get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
        return this.testStatesEmitter.event;
    }

    get autorun(): vscode.Event<void> | undefined {
        return this.autorunEmitter.event;
    }

    constructor(
        public readonly workspaceFolder: vscode.WorkspaceFolder,
        private readonly logger: Logger,
    ) {
        this.disposables.push(this.testsEmitter);
        this.disposables.push(this.testStatesEmitter);
        this.disposables.push(this.autorunEmitter);
        this.disposables.push(this.problemMatcher);

        // Add debug session termination listener
        this.debugSessionDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
            for (const projectKey in this.projectData) {
                if (session.name === this.projectData[projectKey].debugLaunchConfig) {
                    this.cancel(); // Terminate any running Ceedling processes
                    // trigger finish event
                    this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
                    break;
                }
            }
        });
        this.disposables.push(this.debugSessionDisposable);
	
        // callback receive when a config property is modified
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("ceedlingExplorer.problemMatching")) {
                if (!this.getConfiguration().get<boolean>('problemMatching.enabled', false)) {
                    this.problemMatcher.clear();
                }
            }
            let pathChanged = event.affectsConfiguration("ceedlingExplorer.projects");
            let affectedPrettyTestLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestLabel");
            let affectedPrettyTestFileLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestFileLabel");
            if (affectedPrettyTestLabel || affectedPrettyTestFileLabel || pathChanged) {
                this.load();
            }
        })
    }

    private async checkCeedlingVersion() {
        try {
            const version = await this.getCeedlingVersion();
            this.logger.debug(`checkCeedlingVersion()=${version}`);
            this.ceedlingVersionChecked = true;
            if (semver.satisfies(version, "<0.31.2")) {
                this.isOldCeedlingVersion = true;
                return
            }
            this.isOldCeedlingVersion = false;
        }
        catch (e) {
            this.logger.error(`Ceedling Version Check failed: ${util.format(e)}`);
        }
    }

    async load(): Promise<void> {
        this.ceedlingVersionChecked = false;
        this.logger.trace(`load()`);
        this.testsEmitter.fire({ type: 'started' } as TestLoadStartedEvent);
        await this.checkCeedlingVersion();
        if (!this.ceedlingVersionChecked) {
            return;
        }
        for (const projectKey of this.getProjectKeys()) {
            const ymlProjectData = await this.getYmlProjectData(projectKey);
            this.logger.debug(`load(projectKey=${projectKey}, ymlProjectData=${util.format(ymlProjectData)})`);
            this.setBuildDirectory(projectKey, ymlProjectData);
            this.setXmlReportPath(projectKey, ymlProjectData);
            this.setFunctionRegex(projectKey, ymlProjectData);
            this.setFileLabelRegex(projectKey, ymlProjectData);
            this.setTestLabelRegex(projectKey, ymlProjectData);
        }
        const ymlPaths = [] as string[];
        for (const projectKey of this.getProjectKeys()) {
            ymlPaths.push(this.getYmlProjectPath(projectKey));
        }
        const errorMessage = await this.sanityCheck();
        if (errorMessage) {
            this.logger.error(errorMessage);
            this.testsEmitter.fire({
                type: 'finished',
                errorMessage: errorMessage
            } as TestLoadFinishedEvent);
            return;
        }
        this.watchFilesForReload(ymlPaths);
        let filetypes = ['test']
        if (!this.isOldCeedlingVersion) {
            filetypes = ['assembly', 'header', 'source', 'test']

        }
        for (const fileType of filetypes as (keyof ProjectData["files"])[]) {
            this.logger.debug(`loadFileLists(fileType=${fileType})`);
            await this.loadFileLists(fileType);
            for (const projectKey in this.projectData) {
                const files = this.projectData[projectKey].files[fileType];
                if (files) this.watchFilesForAutorun(projectKey, files);
            }
        }
        await this.setTestSuiteInfo();
        this.testsEmitter.fire({ type: 'finished', suite: this.testSuiteInfo } as TestLoadFinishedEvent);
    }

    async run(testIds: string[]): Promise<void> {
        try {
            this.logger.trace(`run(testIds=${util.format(testIds)})`);

            // Ceedling always run the whole file and so run the top test suite
            testIds = testIds.map((x) => x.replace(/::.*/, ''));

            const testSuites = this.getTestSuitesFromTestIds(testIds);
            this.logger.debug(`run(testSuites=${util.format(testSuites)})`);
            this.testStatesEmitter.fire({
                type: 'started',
                tests: testSuites.map((test) => {
                    return test.id;
                })
            } as TestRunStartedEvent);
            this.isCanceled = false;
            for (const testSuite of testSuites) {
                await this.runTestSuite(testSuite);
                if (this.isCanceled) {
                    break;
                }
            }
            this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
        }
        catch (e) {
            this.logger.error(`run error=${util.format(e)}`);
        }
    }

    getProjectKeyFromTest(testId: string): string {
        return testId.split('::')[0];
    }

    async debug(tests: string[]): Promise<void> {
        try {

            // Ceedling always run the whole file and so run the top test suite
            tests = tests.map((x) => x.replace(/::.*/, ''));

            // Determine test suite to run
            const testSuites = this.getTestSuitesFromTestIds(tests);
            const testToExec = testSuites[0].id;
            const projectKey = testSuites[0].projectKey;

            if (!projectKey) {
                this.logger.error(`Could not determine project key for test ${testToExec}`);
                return;
            }

            // trigger testsuite start event
            this.testStatesEmitter.fire({
                type: 'started',
                tests: testSuites.map(test => test.id)
            } as TestRunStartedEvent);
	    // Execute ceedling test compilation
            const args = this.getTestCommandArgs(testToExec);
            const result = await this.execCeedling(args, projectKey);
            if (result.error && /ERROR: Ceedling Failed/.test(result.stdout)) {
                this.logger.showError("Could not compile test, see test output for more details.");
                // trigger failure event
                this.testStatesEmitter.fire({
                    type: 'test',
                    test: testToExec,
                    state: 'failed',
                    message: result.stdout + '\n' + result.stderr
                } as TestEvent);
                this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
                return;
            }
            // Get executable extension
            const ymlProjectData = await this.getYmlProjectData(projectKey);
            const ext = this.getExecutableExtension(ymlProjectData);
            // Get test executable file name without extension
            const testFileName = `${/([^/]*).c$/.exec(testToExec)![1]}`;
            // Set current test executable
            if (this.detectTestSpecificDefines(ymlProjectData, testFileName) || !this.isOldCeedlingVersion) {
                this.setDebugTestExecutable(`${testFileName}/${testFileName}${ext}`);
            } else {
                this.setDebugTestExecutable(`${testFileName}${ext}`);
            }

            // trigger testsuite start event
            this.testStatesEmitter.fire({
                type: 'suite',
                suite: testSuites[0],
                state: 'running'
            } as TestSuiteEvent);

            // trigger test start event
            this.testStatesEmitter.fire({
                type: 'test',
                test: testToExec,
                state: 'running'
            } as TestEvent);

            const debugSessionPromise = vscode.debug.startDebugging(
                this.workspaceFolder,
                this.projectData[projectKey].debugLaunchConfig
            );

            if (!await debugSessionPromise) {
                this.logger.showError(`Debugger could not be started. Check your ceedlingExplorer.projects parameter in settings.`);
                // trigger failure event
                this.testStatesEmitter.fire({
                    type: 'test',
                    test: testToExec,
                    state: 'failed',
                    message: 'Debugger could not be started'
                } as TestEvent);
                this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
            } else {
                // wait for debug session to terminate
                await new Promise<void>((resolve) => {
                    const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
                        if (session.name === this.projectData[projectKey].debugLaunchConfig) {
                            disposable.dispose();
                            resolve();
                        }
                    });
                });

                // trigger testsuite completed event
                this.testStatesEmitter.fire({
                    type: 'suite',
                    suite: testSuites[0],
                    state: 'completed'
                } as TestSuiteEvent);

                // trigger test completed event
                this.testStatesEmitter.fire({
                    type: 'test',
                    test: testToExec,
                    state: 'passed'
                } as TestEvent);

                // trigger test run finished event
                this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
            }
        } catch (error) {
            this.logger.error(`Debug error: ${util.format(error)}`);
            // trigger test run failed event
            this.testStatesEmitter.fire({
                type: 'test',
                test: tests[0].replace(/::.*/, ''),
                state: 'failed',
                message: util.format(error)
            } as TestEvent);
            this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
        } finally {
            // Reset current test executable
            this.setDebugTestExecutable("");
            this.isCanceled = false;
        }
    }

    getDebugTestExecutable(): string {
        return this.debugTestExecutable;
    }

    setDebugTestExecutable(path: string) {
        this.debugTestExecutable = path;
        this.logger.info(`Set the debugTestExecutable to ${this.debugTestExecutable}`);
    }

    async clean(): Promise<void> {
        this.logger.trace(`clean()`);
        const result = await vscode.window.withProgress(
            {
                title: "Ceedling Clean",
                cancellable: true,
                location: vscode.ProgressLocation.Notification,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {
                    this.cancel();
                });
                return this.execCeedlingAllProjects(["clean"]);
            }
        );
        if ((result as any[]).some((x) => x.error)) {
            this.logger.showError("Ceedling clean failed");
        }
    }

    async clobber(): Promise<void> {
        this.logger.trace(`clobber()`);
        const result = await vscode.window.withProgress(
            {
                title: "Ceedling Clobber",
                cancellable: true,
                location: vscode.ProgressLocation.Notification,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {
                    this.cancel();
                });

                return this.execCeedlingAllProjects(["clobber"]);
            }
        );
        if ((result as any[]).some((x) => x.error)) {
            this.logger.showError("Ceedling clean failed");
        }
    }

    cancel(): void {
        this.logger.trace(`cancel()`);
        this.isCanceled = true;
        if (this.ceedlingProcess !== undefined) {
            if (this.ceedlingProcess.pid) {
                tree_kill(this.ceedlingProcess.pid);
            }
        }
        // trigger test run finished event
        this.testStatesEmitter.fire({ type: 'finished' } as TestRunFinishedEvent);
    }

    dispose(): void {
        this.logger.trace(`dispose()`);
        this.cancel();
        if (this.debugSessionDisposable) {
            this.debugSessionDisposable.dispose();
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        // Clear file watches
        for (const file of this.watchedFileForAutorunList) {
            fs.unwatchFile(file);
        }
        for (const file of this.watchedFileForReloadList) {
            fs.unwatchFile(file);
        }
    }

    private async sanityCheck(): Promise<string | void> {
        const sanityCheckErrors = [] as string[];
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`summary`]);
            if (result.error) {
                return `Ceedling failed to run in the configured shell. ` +
                    'Please check if you can run `ceedling summary` in your shell.\n' +
                    `Please check the ceedlingExplorer.shellPath option.\n` +
                    `${result.stdout}\n${result.stderr}`
            }
        } finally {
            release();
        }
        for (const key of this.getProjectKeys()) {
            const error = await this.checkYmlProjectData(key);
            if (error) {
                sanityCheckErrors.push(error);
            }
        }
        if (sanityCheckErrors.length > 0) {
            return sanityCheckErrors.join('\n');
        }
    }

    private async checkYmlProjectData(projectKey: string): Promise<string | void> {
        const ymlProjectData = await this.getYmlProjectData(projectKey)
        if (!ymlProjectData) {
            return `Failed to find or load the project.yml file for ${projectKey}. ` +
                `Please check the ceedlingExplorer.projectPath option.`;
        }
        if (!this.isOldCeedlingVersion) {
            try {
                if (!ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory')) {
                    throw 'Report tests log factory plugin not enabled';
                }
            } catch (e) {
                return `The required Ceedling plugin 'report_tests_log_factory' is not enabled. ` +
                    `You have to edit ${this.getYmlProjectPath(projectKey)} file to enable the plugin.\n` +
                    `see https://github.com/ThrowTheSwitch/Ceedling/blob/master/docs/CeedlingPacket.md` +
                    `#tool-element-runtime-substitution-notational-substitution`;
            }
        }
    }

    private getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('ceedlingExplorer', this.workspaceFolder.uri);
    }

    private getShellPath(): string | undefined {
        const shellPath = this.getConfiguration().get<string>('shellPath', 'null');
        return shellPath !== "null" ? shellPath : undefined;
    }

    private getProjectKeys(): string[] {
        if (Object.keys(this.projectData).length == 0) {
            this.loadProjectPaths();
        }
        return Object.keys(this.projectData);
    }

    private loadProjectPaths() {
        const projectConfigs = this.getConfiguration().get<object>('projects', []) as Array<ProjectConfig>;
        this.projectData = {};
        let workspacePath = this.workspaceFolder.uri.fsPath;
        projectConfigs.forEach(projectConfig => {
            let ymlName = 'project.yml';
            let key = projectConfig.path;
            if (projectConfig.path.endsWith('.yml')) {
                const split = projectConfig.path.split('/');
                ymlName = split[split.length - 1];
                if (ymlName != 'project.yml') {
                    key = ymlName.replace('.yml', '');
                }
                projectConfig.path = projectConfig.path.replace(ymlName, '');
                if (projectConfig.path == '') {
                    projectConfig.path = '.';
                }
            }
            if (projectConfig.name) {
                key = projectConfig.name;
            }
            // Workaround: Uppercase disk letters are required on windows to be able to generate xml gcov reports
            if (process.platform == 'win32') {
                workspacePath = workspacePath.charAt(0).toUpperCase() + workspacePath.slice(1);
            }
            const absolutePath = path.resolve(workspacePath, projectConfig.path);
            if (!(fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory())) {
                throw `The project path ${absolutePath} does not exist or is not a directory.`;
            } else {
                this.projectData[key] = {
                    debugLaunchConfig: projectConfig.debugLaunchConfig,
                    projectPath: projectConfig.path,
                    ymlFileName: ymlName,
                    absPath: absolutePath,
                    files: {}
                };
            }
        });
        if (Object.keys(this.projectData).length == 0) {
            this.projectData['default'] = {
                debugLaunchConfig: 'ceedling',
                projectPath: ".",
                ymlFileName: 'project.yml',
                absPath: path.resolve(workspacePath, "."),
                files: {}
            };
        }
    }

    private async loadFileLists(fileType: keyof ProjectData["files"]): Promise<void> {
        for (const projectKey of this.getProjectKeys()) {
            if (!this.projectData[projectKey].files) {
                this.projectData[projectKey].files = {} as Record<string, string[]>;
            }
            this.logger.debug(`getFileList(fileType=${fileType}, projectKey=${projectKey})`);
            const files = await this.getFileListFromProject(fileType, projectKey);
            this.logger.debug(`gotten ${files.length} ${fileType} files`);
            if (files) {
                this.logger.debug(`adding ${fileType} files to project data`);
                try {
                    this.projectData[projectKey].files[fileType] = files;
                } catch (e) {
                    this.logger.error(`Failed to load ${fileType} files: ${util.format(e)}`);
                }
            }
        };
    }

    private async getFileListFromProject(fileType: string, projectKey: string): Promise<string[]> {
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`files:${fileType}`], projectKey);
            if (result.error) {
                this.logger.error(`Failed to get the list of ${fileType} files: ${util.format(result)}`);
                return [];
            } else {
                return result.stdout.split('\n').filter((value: string) => {
                    return value.startsWith(" - ");
                }).map((value: string) => {
                    return value.substr(3).trim();
                })
            }
        } finally {
            release();
        }
    }

    private getCeedlingCommand(args: ReadonlyArray<string>) {
        const line = `ceedling ${args.join(" ")}`;
        return line;
    }

    private getTestCommandArgs(testToExec: string): Array<string> {
        // Keep only the filename of the test 'test/test_foo.c' -> 'test_foo.c'
        const testSuiteFilename = testToExec.replace(/^.*[\\/]/, "");
        const defaultTestCommandArgs = ["test:${TEST_ID}"];
        const testCommandArgs = this.getConfiguration()
            .get<Array<string>>('testCommandArgs', defaultTestCommandArgs)
            .map(x => x.replace("${TEST_ID}", testSuiteFilename));
        return testCommandArgs;
    }

    private getTestCaseMacroAliases(): Array<string> {
        return this.getConfiguration().get<Array<string>>('testCaseMacroAliases', ['TEST_CASE']);
    }

    private getTestRangeMacroAliases(): Array<string> {
        return this.getConfiguration().get<Array<string>>('testRangeMacroAliases', ['TEST_RANGE']);
    }

    private getExecutableExtension(ymlProjectData: any = undefined) {
        let ext = process.platform == 'win32' ? '.exe' : '.out';
        if (ymlProjectData) {
            try {
                const ymlProjectExt = ymlProjectData[':extension'][':executable'];
                if (ymlProjectExt != undefined) {
                    ext = ymlProjectExt;
                }
            } catch (e) { }
        }
        return ext;
    }

    private detectTestSpecificDefines(ymlProjectData: any = undefined, testFileName: string) {
        if (ymlProjectData) {
            try {
                const ymlProjectExt = ymlProjectData[':defines'][':' + testFileName];
                if (ymlProjectExt != undefined) {
                    return true;
                }
            } catch (e) { }
        }
        return false;
    }

    private async getCeedlingVersion(): Promise<string> {
        const result = await this.execCeedling(['version']);
        const regex = new RegExp('^\\s*Ceedling\\s*(?:::|=>)\\s*(.*)(?:\\n)*$', 'gm');
        const match = regex.exec(result.stdout);
        if (!match) {
            this.logger.error(`fail to get the ceedling version: ${util.format(result)}`);
            return '0.0.0';
        }
        return match[1];
    }

    private execCeedlingAllProjects(args: ReadonlyArray<string>): Promise<any>[] {
        const promises = []
        for (const projectKey of this.getProjectKeys()) {
            promises.push(this.execCeedling(args, projectKey));
        }
        return promises;
    }

    private execCeedling(args: ReadonlyArray<string>, projectKey = Object.keys(this.projectData)[0]): Promise<any> {
        let cwd = ".";
        if (this.ceedlingVersionChecked && projectKey in this.projectData) {
            if (!this.isOldCeedlingVersion) {
                let projectParam = ` --project project.yml`;
                if (this.projectData[projectKey].ymlFileName != 'project.yml') {
                    projectParam += ` --mixin ${this.projectData[projectKey].ymlFileName}`;
                }
                args = [...args, projectParam];
            } else {
                const project = this.projectData[projectKey].ymlFileName.substr(0, this.projectData[projectKey].ymlFileName.lastIndexOf('.'));
                let projectParam = ` project:${project} `;
                args = [...args, projectParam];
            }
            cwd = this.projectData[projectKey].absPath;
        }
        let command = this.getCeedlingCommand(args);
        const shell = this.getShellPath();
        this.logger.debug(`execCeedling(args=${util.format(args)}) \ncommand=${command} \ncwd=${cwd} \nshell=${shell}`);
        return new Promise<any>((resolve) => {
            this.ceedlingProcess = child_process.exec(
                command, { cwd: cwd, shell: shell },
                (error, stdout, stderr) => {
                    const ansiEscapeSequencesRemoved = this.getConfiguration().get<boolean>('ansiEscapeSequencesRemoved', true);
                    if (ansiEscapeSequencesRemoved) {
                        // Remove ansi colors from the outputs
                        stdout = stripAnsi(stdout);
                        stderr = stripAnsi(stderr);
                    }
                    this.logger.debug(`exec done`);
                    resolve({ error, stdout, stderr });
                },
            )
        })
    }

    private watchFilesForAutorun(projectKey: string, files: string[]): void {
        for (const file of files) {
            if (!this.watchedFileForAutorunList.includes(file)) {
                this.watchedFileForAutorunList.push(file);
                const fullPath = path.resolve(this.projectData[projectKey].projectPath, file);
                fs.watchFile(fullPath, () => {
                    this.autorunEmitter.fire();
                });
            }
        }
    }

    private watchFilesForReload(files: string[]): void {
        try {
            for (const file of files) {
                if (!this.watchedFileForReloadList.includes(file)) {
                    this.watchedFileForReloadList.push(file);
                    fs.watchFile(file, () => {
                        this.load();
                    });
                }
            }
        }
        catch (e) {
            this.logger.error(`watchFilesForReload()=${util.format(e)}`);
        }
    }

    private setFunctionRegex(projectKey: string, ymlProjectData: any = undefined) {
        let testPrefix = 'test|spec|should';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':unity'][':test_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    testPrefix = ymlProjectTestPrefix;
                }
            } catch (e) { }
        }
        const macroAliases = [...this.getTestCaseMacroAliases(), ...this.getTestRangeMacroAliases()].join('|');
        this.functionRegexps[projectKey] = new RegExp(
            `^((?:\\s*(?:${macroAliases})\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${testPrefix})(?:.*\\\\\\s+)*.*)\\s*\\(\\s*(.*)\\s*\\)`,
            'gm'
        );
    }

    private setBuildDirectory(projectKey: string, ymlProjectData: any = undefined) {
        let buildDirectory = 'build';
        if (ymlProjectData) {
            try {
                const ymlProjectBuildDirectory = ymlProjectData[':project'][':build_root'];
                if (ymlProjectBuildDirectory != undefined) {
                    buildDirectory = ymlProjectBuildDirectory;
                }
            } catch (e) { }
        }
        this.buildDirectories[projectKey] = buildDirectory;
    }

    private setXmlReportPath(projectKey: string, ymlProjectData: any = undefined) {
        let reportFilename = 'report.xml';
        if (this.isOldCeedlingVersion) {
            if (ymlProjectData) {
                try {
                    const ymlProjectReportFilename = ymlProjectData[':xml_tests_report'][':artifact_filename'];
                    if (ymlProjectReportFilename != undefined) {
                        reportFilename = ymlProjectReportFilename;
                    }
                } catch (e) { }
            }
        } else {
            reportFilename = 'cppunit_tests_report.xml';

            if (ymlProjectData) {
                try {
                    const ymlProjectReportFilename = ymlProjectData[':report_tests_log_factory'][':cppunit'][':filename'];
                    if (ymlProjectReportFilename != undefined) {
                        reportFilename = ymlProjectReportFilename;
                    }
                } catch (e) { }
            }
        }
        this.reportFilenames[projectKey] = reportFilename;
    }

    private getTestFunctionRegex(projectKey: string,): RegExp {
        if (!this.functionRegexps) {
            this.setFunctionRegex(this.projectData[projectKey].projectPath);
        }
        return this.functionRegexps[projectKey] as RegExp;
    }

    private setFileLabelRegex(projectKey: string, ymlProjectData: any = undefined) {
        let filePrefix = 'test_';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':project'][':test_file_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    filePrefix = ymlProjectTestPrefix;
                }
            } catch (e) { }
        }
        this.fileLabelRegexps[projectKey] = new RegExp(`.*\/${filePrefix}(.*).c`, 'i');
    }

    private getFileLabelRegex(projectKey: string,): RegExp {
        if (!this.fileLabelRegexps[projectKey]) {
            this.setFileLabelRegex(projectKey);
        }
        return this.fileLabelRegexps[projectKey] as RegExp;
    }

    private setTestLabelRegex(projectKey: string, ymlProjectData: any = undefined) {
        let testPrefix = 'test|spec|should';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':unity'][':test_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    testPrefix = ymlProjectTestPrefix;
                }
            } catch (e) { }
        }
        this.testLabelRegexps[projectKey] = new RegExp(`(?:${testPrefix})_*(.*)`);
    }

    private getTestLabelRegex(projectKey: string): RegExp {
        if (!this.testLabelRegexps[projectKey]) {
            this.setTestLabelRegex(projectKey);
        }
        return this.testLabelRegexps[projectKey] as RegExp;
    }

    private setTestLabel(projectKey: string, testName: string): string {
        let testLabel = testName;
        if (this.isPrettyTestLabelEnable) {
            const labelFunctionRegex = this.getTestLabelRegex(projectKey);
            let testLabelMatches = labelFunctionRegex.exec(testName);
            if (testLabelMatches != null) {
                testLabel = testLabelMatches[1];
            }
        }
        return testLabel;
    }

    private setFileLabel(projectKey: string, fileName: string): string {
        let fileLabel = fileName;
        if (this.isPrettyTestFileLabelEnable) {
            const labelFileRegex = this.getFileLabelRegex(projectKey);
            let labelMatches = labelFileRegex.exec(fileName);
            if (labelMatches != null) {
                fileLabel = labelMatches[1];
            }
        }
        return fileLabel;
    }

    // Return a list of parameter from a given test token string. An empty array if there is no parameter for this test.
    private parseParametrizedTestCases(testCases: string): Array<any> {
        const testMacroAliases = this.getTestCaseMacroAliases();
        const macroAliases = [...testMacroAliases, ...this.getTestRangeMacroAliases()].join('|');
        const regex = new RegExp(`\s*(${macroAliases})\s*\\((.*)\\)\s*$`, 'gm');
        return [...testCases.matchAll(regex)]
            .flatMap((x: any, i: number) => {
                if (testMacroAliases.includes(x[1])) {
                    return [{ args: x[2], line: i }]
                } else {
                    return [...x[2].matchAll(/\[\s*(-?\d+.?\d*),\s*(-?\d+.?\d*),\s*(-?\d+.?\d*)\s*\]/gm)]
                        .map((y) => [parseFloat(y[1]), parseFloat(y[2]), parseFloat(y[3])])
                        .map(([start, end, inc]) => Array.from({ length: (end - start) / inc + 1 }, (_, j) => start + j * inc))
                        .reduce((acc: any, y) => acc.flatMap((u: any) => y.map(v => [u, v].flat())))
                        .map((y: any) => { return { args: y.join(', '), line: i } })
                }
            });
    }

    private parseMultilineFunctionName(functionName: string): string {
        return functionName.replace(/\\\s*/g, '');
    }

    private setTestSuiteInfo() {
        this.testSuiteInfo = {
            type: 'suite',
            id: 'root',
            label: 'Ceedling',
            isProjectRoot: false,
            projectKey: undefined,
            children: [],
        } as ExtendedTestSuiteInfo;
        /* get labels configuration */
        try {
            this.isPrettyTestFileLabelEnable = this.getConfiguration().get<boolean>('prettyTestFileLabel', false);
            this.isPrettyTestLabelEnable = this.getConfiguration().get<boolean>('prettyTestLabel', false);
            if (this.getProjectKeys().length == 1) {
                const files = this.projectData[this.getProjectKeys()[0]].files['test'];
                if (files) {
                    this.problemMatcher.setActualIds(files);
                    this.testSuiteInfo.children = Array.from(this.getTestSuiteChildren(this.getProjectKeys()[0], files))
                }
            }
            else {
                for (const projectKey of this.getProjectKeys()) {
                    const files = this.projectData[projectKey].files['test'];
                    if (files) {
                        const projectTestSuiteInfo: ExtendedTestSuiteInfo = {
                            type: 'suite',
                            id: projectKey,
                            label: projectKey,
                            children: Array.from(this.getTestSuiteChildren(projectKey, files)),
                            projectKey: projectKey,
                            isProjectRoot: true
                        };
                        this.testSuiteInfo.children.push(projectTestSuiteInfo);
                    }
                }
            }
        }
        catch (e) {
            this.logger.error(`setTestSuiteInfo()=${util.format(e)}`);
        }
    }

    private * getTestSuiteChildren(projectKey: string, files: string[]): Iterable<ExtendedTestSuiteInfo> {
        for (const file of files) {
            const projectPath = this.projectData[projectKey].absPath;
            const fullPath = path.resolve(projectPath, file);
            const fileLabel = this.setFileLabel(projectKey, file);
            const currentTestSuiteInfo: ExtendedTestSuiteInfo = {
                type: 'suite',
                id: file,
                label: fileLabel,
                file: fullPath,
                children: [],
                projectKey: projectKey,
                isProjectRoot: false
            };
            const testRegex = this.getTestFunctionRegex(projectKey);
            const fileText = fs.readFileSync(fullPath, 'utf8');
            let match = testRegex.exec(fileText);
            while (match != null) {
                const testCases = this.parseParametrizedTestCases(match[1]);
                const testName = this.parseMultilineFunctionName(match[2]);
                const testLabel = this.setTestLabel(projectKey, testName);
                let line = fileText.substr(0, match.index).split('\n').length - 1;
                line = line + match[0].substr(0, match[0].search(/\S/g)).split('\n').length - 1;
                if (testCases.length > 0) {
                    const testSuiteInfo: ExtendedTestSuiteInfo = {
                        type: 'suite',
                        id: `${file}::${testName}`,
                        label: testLabel,
                        file: fullPath,
                        children: [],
                        projectKey: projectKey,
                        isProjectRoot: false
                    };
                    for (const testCase of testCases) {
                        const testInfo: ExtendedTestInfo = {
                            type: 'test',
                            id: `${file}::${testName}(${testCase.args})`,
                            label: testCase.args,
                            file: fullPath,
                            line: line + testCase.line,
                            projectKey: projectKey
                        };
                        testSuiteInfo.children.push(testInfo);
                    }
                    currentTestSuiteInfo.children.push(testSuiteInfo)
                } else {
                    const testInfo: ExtendedTestInfo = {
                        type: 'test',
                        id: `${file}::${testName}`,
                        label: testLabel,
                        file: fullPath,
                        line: line,
                        projectKey: projectKey
                    };
                    currentTestSuiteInfo.children.push(testInfo);
                }
                match = testRegex.exec(fileText);
            }
            yield currentTestSuiteInfo;
        }
    }

    private recursiveFindTest(current: TestSuiteInfo | TestInfo, testId: string): TestSuiteInfo | TestInfo | undefined {
        if (current.id === testId) {
            return current;
        } else if (current.type === 'suite') {
            for (const child of current.children) {
                const found = this.recursiveFindTest(child, testId);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }

    private findTest(testId: string): TestSuiteInfo | TestInfo | undefined {
        return this.recursiveFindTest(this.testSuiteInfo, testId);
    }

    private recursiveFindParent(current: TestSuiteInfo | TestInfo, parent: TestSuiteInfo, testId: string): TestSuiteInfo | undefined {
        if (current.id === testId) {
            return parent;
        } else if (current.type === 'suite') {
            for (const child of current.children) {
                const found = this.recursiveFindParent(child, current, testId);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    }

    private findParent(testId: string): TestSuiteInfo | undefined {
        return this.recursiveFindParent(this.testSuiteInfo, this.testSuiteInfo, testId);
    }

    private getTestSuitesFromTestIds(testIds: string[]): ExtendedTestSuiteInfo[] {
        /* Get tests from ids */
        const tests = testIds.map((testId) => {
            return this.findTest(testId);
        }).filter((testInfo) => {
            return testInfo !== undefined;
        }) as (ExtendedTestSuiteInfo | ExtendedTestInfo)[];
        /* Get parent suites */
        const suites = tests.map((test) => {
            if (test.type === 'test') {
                const parent = this.findParent(test.id);
                if (parent === undefined) {
                    throw `Failed to find parent of the test '${test.id}'`
                }
                return parent as ExtendedTestSuiteInfo;
            }
            return test;
        });
        /* Replace the root suite by its children */
        let fixedSuite: typeof suites = [];
        for (const suite of suites) {
            if (suite.id === 'root') {
                const children = suite.children as ExtendedTestSuiteInfo[];
                fixedSuite.push(...children);
            } else {
                fixedSuite.push(suite);
            }
        }
        /* Remove duplicates */
        return [...new Set(fixedSuite)];
    }

    private getYmlProjectPath(projectKey: string): string {
        return path.resolve(
            this.projectData[projectKey].absPath,
            this.projectData[projectKey].ymlFileName
        );
    }

    private getYmlProjectData(projectKey: string): Promise<any | undefined> {
        try {
            if (this.projectData[projectKey].ymlFileName != 'project.yml') {
                return this.mergeYmlProjectData(projectKey);
            }
            return new Promise<any | undefined>((resolve) => {
                const project_yml = this.getYmlProjectPath(projectKey);
                fs.readFile(project_yml, 'utf8', (error, data) => {
                    if (error) {
                        this.logger.error(`Failed to read YAML file '${project_yml}': ${util.format(error)}`);
                        resolve(undefined);
                    }
                    try {
                        const result = yaml.safeLoad(data);
                        resolve(result);
                    } catch (e) {
                        this.logger.error(`Failed to parse YAML file '${project_yml}': ${util.format(e)}`);
                        resolve(undefined);
                    }
                });
            });
        }
        catch (e) {
            this.logger.error(`getYmlProjectData()=${util.format(e)}`);
        }
        return Promise.resolve(undefined);
    }

    private mergeYmlProjectData(projectKey: string): Promise<any | undefined> {
        return new Promise<any | undefined>((resolve) => {
            const project_data = this.getYmlProjectPath(projectKey);
            fs.readFile(project_data, 'utf8', (error, data) => {
                if (error) {
                    this.logger.error(`Failed to read YAML file: ${util.format(error)}`);
                    resolve(undefined);
                }
                try {
                    const result = yaml.safeLoad(data);
                    const defaultYmlPath = path.resolve(this.projectData[projectKey].absPath, 'project.yml');
                    fs.readFile(defaultYmlPath, 'utf8', (error, data) => {
                        if (error) {
                            this.logger.error(`Failed to read default YAML file: ${util.format(error)}`);
                            resolve(result);
                        }
                        try {
                            const defaultResult = yaml.safeLoad(data) || {};
                            const mergedResult = deepmerge(defaultResult, result || {});
                            resolve(mergedResult);
                        } catch (e) {
                            this.logger.error(`Failed to parse default YAML file: ${util.format(e)}`);
                            resolve(result);
                        }
                    });
                } catch (e) {
                    this.logger.error(`Failed to parse YAML file: ${util.format(e)}`);
                    resolve(undefined);
                }
            });
        });
    }

    private getXmlReportPath(projectKey: string): string {
        // Return the latest updated file between artifacts/test/report.xml and artifacts/gcov/report.xml
        // The report is generated in one of these directories based on the command used: ceedling test:* or gcov:*
        const paths: Array<[string, Date]> = ['test', 'gcov']
            .map((x) => path.resolve(
                this.projectData[projectKey].absPath,
                this.buildDirectories[projectKey], 'artifacts', x, this.reportFilenames[projectKey]
            ))
            .map((x) => [x, fs.existsSync(x) ? fs.statSync(x).mtime : new Date(0)]);
        paths.sort((lhs, rhs) => (rhs[1].getTime() - lhs[1].getTime()));
        this.logger.debug(`getXmlReportPath()=${paths}`);
        return paths[0][0];
    }

    private deleteXmlReport(projectKey: string): Promise<void> {
        return new Promise<void>((resolve) => {
            const xmlReportPath = this.getXmlReportPath(projectKey);
            if (fs.existsSync(xmlReportPath)) {
                fs.unlink(xmlReportPath, (error) => {
                    if (error) {
                        this.logger.error(`Failed to delete XML report: ${util.format(error)}`);
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    private getXmlReportData(projectKey: string): Promise<any | undefined> {
        const parser = new xml2js.Parser({ explicitArray: false });
        return new Promise<void>((resolve) => {
            fs.readFile(this.getXmlReportPath(projectKey), 'utf8', (error, data) => {
                if (error) {
                    this.logger.error(`Failed to read XML report: ${util.format(error)}`);
                    resolve(undefined);
                }
                parser.parseString(data, (error: any, result: any) => {
                    if (error) {
                        this.logger.error(`Failed to parse XML report: ${util.format(error)}`);
                        resolve(undefined);
                    }
                    resolve(result);
                });
            });
        });
    }

    private getTestListDataFromXmlReport(xmlReportData: any, testType: string) {
        if (xmlReportData["TestRun"][testType]) {
            if (!(Symbol.iterator in Object(xmlReportData["TestRun"][testType]["Test"]))) {
                xmlReportData["TestRun"][testType]["Test"] = [xmlReportData["TestRun"][testType]["Test"]];
            }
            return xmlReportData["TestRun"][testType]["Test"];
        } else {
            return [];
        }
    }

    // Utility function to do dfs of a given test suite
    // Returns the list of node in traversal order
    private testInfoDfs(root: TestSuiteInfo | TestInfo): Array<TestSuiteInfo | TestInfo> {
        const ret = [];
        const stack = Array<TestSuiteInfo | TestInfo>();
        stack.push(root);
        while (stack.length > 0) {
            const node = stack.pop()!;
            ret.push(node);
            if (node.type === 'suite') {
                for (const child of node.children) {
                    stack.push(child);
                }
            }
        }
        return ret;
    }

    private async runTestSuite(testSuite: ExtendedTestSuiteInfo): Promise<void> {
        if (!testSuite.projectKey) {
            this.logger.error(`Could not determine project key for test suite ${testSuite.id}`);
            return;
        }
        this.testStatesEmitter.fire({ type: 'suite', suite: testSuite, state: 'running' } as TestSuiteEvent);
        const release = await this.ceedlingMutex.acquire();
        try {
            for (const child of this.testInfoDfs(testSuite)) {
                this.testStatesEmitter.fire({ type: child.type, test: child, state: 'running' } as TestEvent);
            }
            /* Delete the xml report from the artifacts */
            await this.deleteXmlReport(testSuite.projectKey);
            /* Run the test and get stdout */
            let result = undefined;
            let message = "";
            if (testSuite.isProjectRoot) {
                const args = this.getTestCommandArgs('all');
                result = await this.execCeedling(args, testSuite.projectKey);
                message = `stdout:\n${result.stdout}` + ((result.stderr.length != 0) ? `\nstderr:\n${result.stderr}` : ``);
            }
            else {
                const args = this.getTestCommandArgs(testSuite.id);
                result = await this.execCeedling(args, testSuite.projectKey);
                message = `stdout:\n${result.stdout}` + ((result.stderr.length != 0) ? `\nstderr:\n${result.stderr}` : ``);
            }

            this.problemMatcher.scan(testSuite.id, result.stdout, result.stderr, this.projectData[testSuite.projectKey].projectPath,
                this.getConfiguration().get<string>('problemMatching.mode', ""),
                this.getConfiguration().get<ProblemMatchingPattern[]>('problemMatching.patterns', []));

            const xmlReportData = await this.getXmlReportData(testSuite.projectKey);
            this.logger.debug(`xmlReportData=${util.format(xmlReportData)}`);
            if (xmlReportData === undefined) {
                /* The tests are not run so return error */
                for (const child of this.testInfoDfs(testSuite)) {
                    this.testStatesEmitter.fire({ type: child.type, test: child, state: 'errored', message: message } as TestEvent);
                }
            } else {
                /* Send the events from the xml report data */
                for (const ignoredTest of this.getTestListDataFromXmlReport(xmlReportData, "IgnoredTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: ignoredTest["Name"],
                        state: 'skipped',
                        message: message
                    } as TestEvent);
                }
                for (const succefullTest of this.getTestListDataFromXmlReport(xmlReportData, "SuccessfulTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: succefullTest["Name"],
                        state: 'passed',
                        message: message
                    } as TestEvent);
                }
                for (const failedTest of this.getTestListDataFromXmlReport(xmlReportData, "FailedTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: failedTest["Name"],
                        state: 'failed',
                        message: message,
                        decorations: [{
                            line: parseInt(failedTest["Location"]["Line"]) - 1,
                            message: failedTest["Message"].toString()
                        }]
                    } as TestEvent);
                }
            }
        } finally {
            release();
        }
        this.testStatesEmitter.fire({ type: 'suite', suite: testSuite, state: 'completed' } as TestSuiteEvent);
    }
}

