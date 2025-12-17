import child_process from 'child_process';
import util from 'util';
import { Mutex } from 'async-mutex';
import tree_kill from 'tree-kill';
import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import xml2js from 'xml2js';
import vscode from 'vscode';
import stripAnsi from 'strip-ansi';
import semver from 'semver';
import {
    TestAdapter,
    TestLoadStartedEvent,
    TestLoadFinishedEvent,
    TestRunStartedEvent,
    TestRunFinishedEvent,
    TestSuiteEvent,
    TestEvent,
    TestSuiteInfo,
    TestInfo
} from 'vscode-test-adapter-api';
import { ProblemMatcher, ProblemMatchingPattern } from './problemMatcher';
import { Logger } from './logger'

export class CeedlingAdapter implements TestAdapter {
    private disposables: { dispose(): void }[] = [];

    private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
    private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
    private readonly autorunEmitter = new vscode.EventEmitter<void>();

    private readonly problemMatcher = new ProblemMatcher();

    private ceedlingProcess: child_process.ChildProcess | undefined;
    private functionRegex: RegExp | undefined;
    private fileLabelRegex: RegExp | undefined;
    private testLabelRegex: RegExp | undefined;
    private debugTestExecutable: string = '';
    private debugTestExecutablePath: string = '';
    private buildDirectory: string = '';
    private reportFilename: string = '';
    private watchedFileForAutorunList: string[] = [];
    private watchedFileForReloadList: string[] = [];
    private testSuiteInfo: TestSuiteInfo = {
        type: 'suite',
        id: 'root',
        label: 'Ceedling',
        children: []
    };
    private isCanceled: boolean = false;
    private isPrettyTestLabelEnable: boolean = false;
    private isPrettyTestFileLabelEnable: boolean = false;
    private ceedlingMutex: Mutex = new Mutex();

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
        // callback receive when a config property is modified
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("ceedlingExplorer.problemMatching")) {
                if (!this.getConfiguration().get<boolean>('problemMatching.enabled', false)) {
                    this.problemMatcher.clear();
                }
            }

            let affectedPrettyTestLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestLabel");
            let affectedPrettyTestFileLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestFileLabel");
            if (affectedPrettyTestLabel || affectedPrettyTestFileLabel) {
                this.load();
            }
        })
    }

    async load(): Promise<void> {
        this.logger.trace(`load()`);

        this.testsEmitter.fire({ type: 'started' } as TestLoadStartedEvent);

        const errorMessage = await this.sanityCheck();
        if (errorMessage) {
            this.logger.error(errorMessage);
            this.testsEmitter.fire({
                type: 'finished',
                errorMessage: errorMessage
            } as TestLoadFinishedEvent);
            return;
        }

        const ymlProjectData = await this.getYmlProjectData();
        this.setBuildDirectory(ymlProjectData);
        this.setXmlReportPath(ymlProjectData);
        this.setFunctionRegex(ymlProjectData);
        this.setFileLabelRegex(ymlProjectData);
        this.setTestLabelRegex(ymlProjectData);
        this.watchFilesForReload([this.getYmlProjectPath()]);

        const assemblyFiles = await this.getFileList('assembly');
        const headerFiles = await this.getFileList('header');
        const sourceFiles = await this.getFileList('source');
        const testFiles = await this.getFileList('test');

        this.watchFilesForAutorun(assemblyFiles);
        this.watchFilesForAutorun(headerFiles);
        this.watchFilesForAutorun(sourceFiles);

        this.watchFilesForReload(testFiles);

        await this.setTestSuiteInfo(testFiles);
        this.testsEmitter.fire({ type: 'finished', suite: this.testSuiteInfo } as TestLoadFinishedEvent);
    }

    async run(testIds: string[]): Promise<void> {
        this.logger.trace(`run(testIds=${util.format(testIds)})`);

        // Ceedling always run the whole file and so run the top test suite
        testIds = testIds.map((x) => x.replace(/::.*/, ''));

        const testSuites = this.getTestSuitesFromTestIds(testIds);
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

    async debug(tests: string[]): Promise<void> {
        this.logger.trace(`debug(tests=${util.format(tests)})`);
        try {
            // Get and validate debug configuration
            const debugConfiguration = this.getConfiguration().get<string>('debugConfiguration', '');
            if (!debugConfiguration) {
                this.logger.showError("No debug configuration specified. In Settings, set ceedlingExplorer.debugConfiguration.");
                return;
            }

            // Ceedling always run the whole file and so run the top test suite
            tests = tests.map((x) => x.replace(/::.*/, ''));

            // Determine test suite to run
            const testSuites = this.getTestSuitesFromTestIds(tests);
            const testToExec = testSuites[0].id;

            // Execute ceedling test compilation
            const args = this.getTestCommandArgs(testToExec);
            const result = await this.execCeedling(args);
            if (result.error && /ERROR: Ceedling Failed/.test(result.stdout)) {
                this.logger.showError("Could not compile test, see test output for more details.");
                return;
            }

            // Get executable extension
            const ymlProjectData = await this.getYmlProjectData();
            const ext = this.getExecutableExtension(ymlProjectData);

            // Get test executable file name without extension
            const testFileName = `${/([^/]*).c$/.exec(testToExec)![1]}`;

            // Set current test executable
            // Use subdirectory format for Ceedling 1.0+ or tests with specific defines
            const useSubdirectory = this.isCeedling1Plus(ymlProjectData) || this.detectTestSpecificDefines(ymlProjectData, testFileName);
            const executableRelPath = useSubdirectory ? `${testFileName}/${testFileName}${ext}` : `${testFileName}${ext}`;

            this.setDebugTestExecutable(executableRelPath);
            this.setDebugTestExecutablePath(`${this.buildDirectory}/test/out/${executableRelPath}`);

            // Launch debugger
            if (!await vscode.debug.startDebugging(this.workspaceFolder, debugConfiguration))
                this.logger.showError("Debugger could not be started.");
        }
        finally {
            // Reset current test executable
            this.setDebugTestExecutable("");
            this.setDebugTestExecutablePath("");
        }
    }

    getDebugTestExecutable(): string {
        return this.debugTestExecutable;
    }

    setDebugTestExecutable(path: string) {
        this.debugTestExecutable = path;
        this.logger.info(`Set the debugTestExecutable to ${this.debugTestExecutable}`);
    }

    getDebugTestExecutablePath(): string {
        return this.debugTestExecutablePath;
    }

    setDebugTestExecutablePath(path: string) {
        this.debugTestExecutablePath = path;
        this.logger.info(`Set the debugTestExecutablePath to ${this.debugTestExecutablePath}`);
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

                return this.execCeedling(["clean"]);
            }
        );
        if (result.error) {
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

                return this.execCeedling(["clobber"]);
            }
        );
        if (result.error) {
            this.logger.showError("Ceedling clobber failed");
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
    }

    dispose(): void {
        this.logger.trace(`dispose()`);
        this.cancel();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
    }

    private async sanityCheck(): Promise<string | void> {
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`summary`]);
            if (result.error) {
                return `Ceedling failed to run in the configured shell. ` +
                    `Please check the ceedlingExplorer.shellPath option.\n` +
                    `${result.stdout}\n${result.stderr}`
            }
        } finally {
            release();
        }
        const ymlProjectData = await this.getYmlProjectData();
        if (!ymlProjectData) {
            return `Failed to find the project.yml file. ` +
                `Please check the ceedlingExplorer.projectPath option.`;
        }
        try {
            const hasXmlTestsReport = ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report');
            const hasReportFactory = ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');

            if (!hasXmlTestsReport && !hasReportFactory) {
                throw 'Xml report plugin not enabled';
            }

            // For report_tests_log_factory, verify cppunit format is enabled
            if (hasReportFactory && !hasXmlTestsReport) {
                try {
                    const reports = ymlProjectData[':report_tests_log_factory'][':reports'];
                    if (!reports || !reports.includes('cppunit')) {
                        throw 'CppUnit report not enabled in report_tests_log_factory';
                    }
                } catch (e) {
                    return `The 'report_tests_log_factory' plugin is enabled but 'cppunit' report format is not configured. ` +
                        `Add 'cppunit' to :report_tests_log_factory::reports list in your project.yml file.`;
                }
            }
        } catch (e) {
            return `A required Ceedling XML report plugin is not enabled. ` +
                `For Ceedling 0.31.x, enable 'xml_tests_report' plugin. ` +
                `For Ceedling 1.0+, enable 'report_tests_log_factory' plugin with 'cppunit' report format.\n` +
                `see https://github.com/ThrowTheSwitch/Ceedling/blob/master/docs/CeedlingPacket.md`;
        }
    }

    private getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('ceedlingExplorer', this.workspaceFolder.uri);
    }

    private getShellPath(): string | undefined {
        const shellPath = this.getConfiguration().get<string>('shellPath', 'null');
        return shellPath !== "null" ? shellPath : undefined;
    }

    private getProjectPath(): string {
        const defaultProjectPath = '.';
        const projectPath = this.getConfiguration().get<string>('projectPath', defaultProjectPath);
        let workspacePath = this.workspaceFolder.uri.fsPath;
        // Workaround: Uppercase disk letters are required on windows to be able to generate xml gcov reports
        if (process.platform == 'win32') {
            workspacePath = workspacePath.charAt(0).toUpperCase() + workspacePath.slice(1);
        }
        const absolutePath = path.resolve(workspacePath, projectPath);
        if (!(fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isDirectory())) {
            // TODO: We are silently using the default project path. The user should be warned
            return path.resolve(workspacePath, defaultProjectPath);
        }
        return absolutePath;
    }

    private async getFileList(fileType: string): Promise<string[]> {
        const release = await this.ceedlingMutex.acquire();
        try {
            const result = await this.execCeedling([`files:${fileType}`]);
            if (result.error) {
                return [];
            } else {
                return result.stdout.split('\n').filter((value: string) => {
                    return value.startsWith(" - ");
                }).map((value: string) => {
                    return value.substr(3).trim();
                }).filter((filePath: string) => {
                    // Exclude files from the build output directory (preprocessed files, runners, etc.)
                    // These would create duplicate entries in the test explorer
                    return !filePath.includes(this.buildDirectory);
                });
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

    private isCeedling1Plus(ymlProjectData: any = undefined): boolean {
        if (ymlProjectData) {
            try {
                return ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory');
            } catch (e) { }
        }
        return false;
    }

    private async getCeedlingVersion(): Promise<string> {
        const result = await this.execCeedling(['version']);
        const regex = new RegExp('^\\s*Ceedling::\\s*(.*)$', 'gm');
        const match = regex.exec(result.stdout);
        if (!match) {
            this.logger.error(`fail to get the ceedling version: ${util.format(result)}`);
            return '0.0.0';
        }
        return match[1];
    }

    private execCeedling(args: ReadonlyArray<string>): Promise<any> {
        this.logger.trace(`execCeedling(args=${util.format(args)})`);
        const command = this.getCeedlingCommand(args);
        const cwd = this.getProjectPath();
        const shell = this.getShellPath();
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
                    this.logger.debug(`exec(command=${util.format(command)}, ` +
                        `cwd=${util.format(cwd)}, ` +
                        `shell=${util.format(shell)}, ` +
                        `error=${util.format(error)}, ` +
                        `stdout=${util.format(stdout)}, ` +
                        `stderr=${util.format(stderr)})`);
                    resolve({ error, stdout, stderr });
                },
            )
        })
    }

    private watchFilesForAutorun(files: string[]): void {
        for (const file of files) {
            if (!this.watchedFileForAutorunList.includes(file)) {
                this.watchedFileForAutorunList.push(file);
                const fullPath = path.resolve(this.getProjectPath(), file);
                fs.watchFile(fullPath, () => {
                    this.autorunEmitter.fire();
                });
            }
        }
    }

    private watchFilesForReload(files: string[]): void {
        for (const file of files) {
            if (!this.watchedFileForReloadList.includes(file)) {
                this.watchedFileForReloadList.push(file);
                const fullPath = path.resolve(this.getProjectPath(), file);
                fs.watchFile(fullPath, () => {
                    this.load();
                });
            }
        }
    }

    private setFunctionRegex(ymlProjectData: any = undefined) {
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
        this.functionRegex = new RegExp(
            `^((?:\\s*(?:${macroAliases})\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${testPrefix})(?:.*\\\\\\s+)*.*)\\s*\\(\\s*(.*)\\s*\\)`,
            'gm'
        );
    }

    private execRubySync(args: ReadonlyArray<string>): string {
        this.logger.trace(`execRuby(args=${util.format(args)})`);
        const command = `ruby -e "${args.join(" ").replace(/"/g, '\\"')}"`;
        const cwd = this.getProjectPath();
        const shell = this.getShellPath();
        const stdout = child_process.execSync(
            command, { cwd: cwd, shell: shell },
        ).toString().trim();
        this.logger.debug(`execSync(command=${util.format(command)}, ` +
            `cwd=${util.format(cwd)}, ` +
            `shell=${util.format(shell)}, ` +
            `stdout=${util.format(stdout)}`);
        return stdout;
    }

    private evalRuby(str: string) {
        const evalRuby = this.getConfiguration().get<boolean>('evalRubyInStrings', false);
        if (!evalRuby) {
            return str;
        }
        return str.replace(/#\{(.+)\}/g, (_, match) => {
            const stdout = this.execRubySync(["p", match]);
            if (stdout.startsWith('"') && stdout.endsWith('"')) {
                return stdout.slice(1, -1);
            }
            return stdout;
        });
    }

    private setBuildDirectory(ymlProjectData: any = undefined) {
        let buildDirectory = 'build';
        if (ymlProjectData) {
            try {
                const ymlProjectBuildDirectory = ymlProjectData[':project'][':build_root'];
                if (ymlProjectBuildDirectory != undefined) {
                    buildDirectory = this.evalRuby(ymlProjectBuildDirectory);
                }
            } catch (e) { }
        }
        this.buildDirectory = buildDirectory;
    }

    private setXmlReportPath(ymlProjectData: any = undefined) {
        let reportFilename = 'report.xml';
        if (ymlProjectData) {
            // Try new Ceedling 1.0+ report_tests_log_factory plugin first
            try {
                const ymlProjectReportFilename = ymlProjectData[':report_tests_log_factory'][':cppunit'][':filename'];
                if (ymlProjectReportFilename != undefined) {
                    reportFilename = ymlProjectReportFilename;
                }
            } catch (e) {
                // Fall back to old xml_tests_report plugin (Ceedling 0.31.x)
                try {
                    const ymlProjectReportFilename = ymlProjectData[':xml_tests_report'][':artifact_filename'];
                    if (ymlProjectReportFilename != undefined) {
                        reportFilename = ymlProjectReportFilename;
                    }
                } catch (e) {
                    // If report_tests_log_factory is enabled but no custom filename, use default
                    try {
                        if (ymlProjectData[':plugins'][':enabled'].includes('report_tests_log_factory')) {
                            reportFilename = 'cppunit_tests_report.xml';
                        }
                    } catch (e) { }
                }
            }
        }
        this.reportFilename = reportFilename;
    }

    private getTestFunctionRegex(): RegExp {
        if (!this.functionRegex) {
            this.setFunctionRegex();
        }
        return this.functionRegex as RegExp;
    }

    private setFileLabelRegex(ymlProjectData: any = undefined) {
        let filePrefix = 'test_';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':project'][':test_file_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    filePrefix = ymlProjectTestPrefix;
                }
            } catch (e) { }
        }
        this.fileLabelRegex = new RegExp(`.*\/${filePrefix}(.*).c`, 'i');
    }

    private getFileLabelRegex(): RegExp {
        if (!this.fileLabelRegex) {
            this.setFileLabelRegex();
        }
        return this.fileLabelRegex as RegExp;
    }

    private setTestLabelRegex(ymlProjectData: any = undefined) {
        let testPrefix = 'test|spec|should';
        if (ymlProjectData) {
            try {
                const ymlProjectTestPrefix = ymlProjectData[':unity'][':test_prefix'];
                if (ymlProjectTestPrefix != undefined) {
                    testPrefix = ymlProjectTestPrefix;
                }
            } catch (e) { }
        }
        this.testLabelRegex = new RegExp(`(?:${testPrefix})_*(.*)`);
    }

    private getTestLabelRegex(): RegExp {
        if (!this.testLabelRegex) {
            this.setTestLabelRegex();
        }
        return this.testLabelRegex as RegExp;
    }

    private setTestLabel(testName: string): string {
        let testLabel = testName;
        if (this.isPrettyTestLabelEnable) {
            const labelFunctionRegex = this.getTestLabelRegex();
            let testLabelMatches = labelFunctionRegex.exec(testName);
            if (testLabelMatches != null) {
                testLabel = testLabelMatches[1];
            }
        }
        return testLabel;
    }

    private setFileLabel(fileName: string): string {
        let fileLabel = fileName;
        if (this.isPrettyTestFileLabelEnable) {
            const labelFileRegex = this.getFileLabelRegex();
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

    private setTestSuiteInfo(files: string[]) {
        this.testSuiteInfo = {
            type: 'suite',
            id: 'root',
            label: 'Ceedling',
            children: []
        } as TestSuiteInfo;

        this.problemMatcher.setActualIds(files);

        /* get labels configuration */
        this.isPrettyTestFileLabelEnable = this.getConfiguration().get<boolean>('prettyTestFileLabel', false);
        this.isPrettyTestLabelEnable = this.getConfiguration().get<boolean>('prettyTestLabel', false);

        for (const file of files) {
            const fullPath = path.resolve(this.getProjectPath(), file);
            const fileLabel = this.setFileLabel(file);
            const currentTestSuitInfo: TestSuiteInfo = {
                type: 'suite',
                id: file,
                label: fileLabel,
                file: fullPath,
                children: []
            };
            const testRegex = this.getTestFunctionRegex();
            const fileText = fs.readFileSync(fullPath, 'utf8');
            let match = testRegex.exec(fileText);
            while (match != null) {
                const testCases = this.parseParametrizedTestCases(match[1]);
                const testName = this.parseMultilineFunctionName(match[2]);
                const testLabel = this.setTestLabel(testName);
                let line = fileText.substr(0, match.index).split('\n').length - 1;
                line = line + match[0].substr(0, match[0].search(/\S/g)).split('\n').length - 1;
                if (testCases.length > 0) {
                    const testSuiteInfo: TestSuiteInfo = {
                        type: 'suite',
                        id: `${file}::${testName}`,
                        label: testLabel,
                        file: fullPath,
                        children: []
                    };
                    for (const testCase of testCases) {
                        const testInfo: TestInfo = {
                            type: 'test',
                            id: `${file}::${testName}(${testCase.args})`,
                            label: testCase.args,
                            file: fullPath,
                            line: line + testCase.line
                        };
                        testSuiteInfo.children.push(testInfo);
                    }
                    currentTestSuitInfo.children.push(testSuiteInfo)
                } else {
                    const testInfo: TestInfo = {
                        type: 'test',
                        id: `${file}::${testName}`,
                        label: testLabel,
                        file: fullPath,
                        line: line
                    };
                    currentTestSuitInfo.children.push(testInfo);
                }
                match = testRegex.exec(fileText);
            }
            this.testSuiteInfo.children.push(currentTestSuitInfo);
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

    private getTestSuitesFromTestIds(testIds: string[]): TestSuiteInfo[] {
        /* Get tests from ids */
        const tests = testIds.map((testId) => {
            return this.findTest(testId);
        }).filter((testInfo) => {
            return testInfo !== undefined;
        }) as (TestSuiteInfo | TestInfo)[];
        /* Get parent suites */
        const suites = tests.map((test) => {
            if (test.type === 'test') {
                const parent = this.findParent(test.id);
                if (parent === undefined) {
                    throw `Failed to find parent of the test '${test.id}'`
                }
                return parent as TestSuiteInfo;
            }
            return test;
        });
        /* Replace the root suite by its children */
        let fixedSuite: typeof suites = [];
        for (const suite of suites) {
            if (suite.id === 'root') {
                const children = suite.children as TestSuiteInfo[];
                fixedSuite.push(...children);
            } else {
                fixedSuite.push(suite);
            }
        }
        /* Remove duplicates */
        return [...new Set(fixedSuite)];
    }

    private getYmlProjectPath(): string {
        return path.resolve(
            this.getProjectPath(),
            'project.yml'
        );
    }

    private getYmlProjectData(): Promise<any | undefined> {
        return new Promise<any | undefined>((resolve) => {
            fs.readFile(this.getYmlProjectPath(), 'utf8', (error, data) => {
                if (error) {
                    resolve(undefined);
                }
                try {
                    const result = yaml.safeLoad(data);
                    resolve(result);
                } catch (e) {
                    resolve(undefined);
                }
            });
        });
    }

    private getXmlReportPath(): string {
        // Return the latest updated file between artifacts/test/report.xml and artifacts/gcov/report.xml
        // The report is generated in one of these directories based on the command used: ceedling test:* or gcov:*
        const paths: Array<[string, Date]> = ['test', 'gcov']
            .map((x) => path.resolve(
                this.getProjectPath(),
                this.buildDirectory, 'artifacts', x, this.reportFilename
            ))
            .map((x) => [x, fs.existsSync(x) ? fs.statSync(x).mtime : new Date(0)]);
        paths.sort((lhs, rhs) => (rhs[1].getTime() - lhs[1].getTime()));
        return paths[0][0];
    }

    private deleteXmlReport(): Promise<void> {
        return new Promise<void>((resolve) => {
            fs.unlink(this.getXmlReportPath(), () => {
                resolve();
            });
        });
    }

    private getXmlReportData(): Promise<any | undefined> {
        const parser = new xml2js.Parser({ explicitArray: false });
        return new Promise<void>((resolve) => {
            fs.readFile(this.getXmlReportPath(), 'utf8', (error, data) => {
                if (error) {
                    resolve(undefined);
                }
                parser.parseString(data, (error: any, result: any) => {
                    if (error) {
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

    private async runTestSuite(testSuite: TestSuiteInfo): Promise<void> {
        this.testStatesEmitter.fire({ type: 'suite', suite: testSuite, state: 'running' } as TestSuiteEvent);
        const release = await this.ceedlingMutex.acquire();
        try {
            for (const child of this.testInfoDfs(testSuite)) {
                this.testStatesEmitter.fire({ type: child.type, test: child, state: 'running' } as TestEvent);
            }
            /* Delete the xml report from the artifacts */
            await this.deleteXmlReport();
            /* Run the test and get stdout */
            const args = this.getTestCommandArgs(testSuite.id);
            const result = await this.execCeedling(args);
            const message: string = `stdout:\n${result.stdout}` + ((result.stderr.length != 0) ? `\nstderr:\n${result.stderr}` : ``);

            this.problemMatcher.scan(testSuite.id, result.stdout, result.stderr, this.getProjectPath(),
                this.getConfiguration().get<string>('problemMatching.mode', ""),
                this.getConfiguration().get<ProblemMatchingPattern[]>('problemMatching.patterns', []));

            const xmlReportData = await this.getXmlReportData();
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

