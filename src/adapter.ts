import * as child_process from 'child_process';
import * as async_mutex from 'async-mutex';
import * as tree_kill from 'tree-kill';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as xml2js from 'xml2js';
import * as vscode from 'vscode';
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

export class CeedlingAdapter implements TestAdapter {
    private disposables: { dispose(): void }[] = [];

    private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
    private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
    private readonly autorunEmitter = new vscode.EventEmitter<void>();

    private ceedlingProcess: child_process.ChildProcess | undefined;
    private functionRegex: RegExp | undefined;
    private fileLabelRegex: RegExp | undefined;
    private testLabelRegex: RegExp | undefined;
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
    private ceedlingMutex: async_mutex.Mutex = new async_mutex.Mutex();

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
        public readonly workspaceFolder: vscode.WorkspaceFolder
    ) {
        this.disposables.push(this.testsEmitter);
        this.disposables.push(this.testStatesEmitter);
        this.disposables.push(this.autorunEmitter);
        // callback receive when a config property is modified
        vscode.workspace.onDidChangeConfiguration(event => {
            let affectedPrettyTestLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestLabel");
            let affectedPrettyTestFileLabel = event.affectsConfiguration("ceedlingExplorer.prettyTestFileLabel");
            if (affectedPrettyTestLabel || affectedPrettyTestFileLabel) {
                this.load();
            }
        })
    }

    async load(): Promise<void> {
        this.testsEmitter.fire({ type: 'started' } as TestLoadStartedEvent);

        const errorMessage = await this.sanityCheck();
        if (errorMessage) {
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
        this.watchFilesForAutorun(testFiles);

        this.watchFilesForReload(testFiles);

        await this.setTestSuiteInfo(testFiles);
        this.testsEmitter.fire({ type: 'finished', suite: this.testSuiteInfo } as TestLoadFinishedEvent);
    }

    async run(testIds: string[]): Promise<void> {
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
        try {
            // Get and validate debug configuration
            const debugConfiguration = this.getConfiguration().get<string>('debugConfiguration', '');
            if (!debugConfiguration) {
                vscode.window.showErrorMessage("No debug configuration specified. In Settings, set ceedlingExplorer.debugConfiguration.");
                return;
            }

            // Determine test suite to run
            const testSuites = this.getTestSuitesFromTestIds(tests);
            const testToExec = testSuites[0].id;

            // Execute ceedling test compilation
            const args = this.getTestCommandArgs(testToExec);
            const result = await this.execCeedling(args);
            if (result.error && /ERROR: Ceedling Failed/.test(result.stdout)) {
                vscode.window.showErrorMessage("Could not compile test, see test output for more details.");
                return;
            }

            // Get executable extension
            const ymlProjectData = await this.getYmlProjectData();
            const ext = this.getExecutableExtension(ymlProjectData);

            // Get test executable file name without extension
            const testFileName = `${/([^/]*).c$/.exec(testToExec)![1]}`;

            // Set current test executable
            if (this.detectTestSpecificDefines(ymlProjectData, testFileName))
                g_debugTestExecutable = `${testFileName}/${testFileName}${ext}`
            else
                g_debugTestExecutable = `${testFileName}${ext}`;

            // Launch debugger
            if (!await vscode.debug.startDebugging(this.workspaceFolder, debugConfiguration))
                vscode.window.showErrorMessage("Debugger could not be started.");
        }
        finally {
            // Reset current test executable
            g_debugTestExecutable = "";
        }
    }

    cancel(): void {
        this.isCanceled = true;
        if (this.ceedlingProcess !== undefined) {
            tree_kill(this.ceedlingProcess.pid);
        }
    }

    dispose(): void {
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
            if (!ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report')) {
                throw 'Xml report plugin not enabled';
            }
        } catch (e) {
            return `The required Ceedling plugin 'xml_tests_report' is not enabled. ` +
                `You have to edit your 'project.xml' file to enable the plugin.\n` +
                `see https://github.com/ThrowTheSwitch/Ceedling/blob/master/docs/CeedlingPacket.md` +
                `#tool-element-runtime-substitution-notational-substitution`;
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
        return path.resolve(workspacePath, projectPath !== "null" ? projectPath : defaultProjectPath);
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
        const defaultTestCommandArgs = ["test:${TEST_ID}"];
        const testCommandArgs = this.getConfiguration()
            .get<Array<string>>('testCommandArgs', defaultTestCommandArgs)
            .map(x => x.replace("${TEST_ID}", testToExec));
        return testCommandArgs;
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

    private execCeedling(args: ReadonlyArray<string>): Promise<any> {
        return new Promise<any>((resolve) => {
            this.ceedlingProcess = child_process.exec(
                this.getCeedlingCommand(args),
                {
                    cwd: this.getProjectPath(),
                    shell: this.getShellPath(),
                },
                (error, stdout, stderr) => {
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
        this.functionRegex = new RegExp(
            `^((?:\\s*TEST_CASE\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${testPrefix})(?:.*\\\\\\s+)*.*)\\s*\\(\\s*(.*)\\s*\\)`,
            'gm'
        );
    }

    private setBuildDirectory(ymlProjectData: any = undefined) {
        let buildDirectory = 'build';
        if (ymlProjectData) {
            try {
                const ymlProjectBuildDirectory = ymlProjectData[':project'][':build_root'];
                if (ymlProjectBuildDirectory != undefined) {
                    buildDirectory = ymlProjectBuildDirectory;
                }
            } catch (e) { }
        }
        this.buildDirectory = buildDirectory;
    }

    private setXmlReportPath(ymlProjectData: any = undefined) {
        let reportFilename = 'report.xml';
        if (ymlProjectData) {
            try {
                const ymlProjectReportFilename = ymlProjectData[':xml_tests_report'][':artifact_filename'];
                if (ymlProjectReportFilename != undefined) {
                    reportFilename = ymlProjectReportFilename;
                }
            } catch (e) { }
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

    private setTestLabel(testName: string): string | undefined {
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
                let testName = match[2];
                testName = this.parseMultilineFunctionName(testName);
                const testLabel = this.setTestLabel(testName);
                let line = fileText.substr(0, match.index).split('\n').length - 1;
                line = line + match[0].substr(0, match[0].search(/\S/g)).split('\n').length - 1;
                currentTestSuitInfo.children.push({
                    type: 'test',
                    id: file + '::' + testName,
                    label: testLabel,
                    file: fullPath,
                    line: line
                } as TestInfo)
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
        return new Promise<void>((resolve) => {
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
        return path.resolve(
            this.getProjectPath(),
            this.buildDirectory, 'artifacts', 'test', this.reportFilename
        );
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

    private async runTestSuite(testSuite: TestSuiteInfo): Promise<void> {
        this.testStatesEmitter.fire({ type: 'suite', suite: testSuite, state: 'running' } as TestSuiteEvent);
        const release = await this.ceedlingMutex.acquire();
        try {
            for (const child of testSuite.children) {
                this.testStatesEmitter.fire({ type: 'test', test: child, state: 'running' } as TestEvent);
            }
            /* Delete the xml report from the artifacts */
            await this.deleteXmlReport();
            /* Run the test and get stdout */
            const args = this.getTestCommandArgs(testSuite.label);
            const result = await this.execCeedling(args);
            const xmlReportData = await this.getXmlReportData();
            if (xmlReportData === undefined) {
                /* The tests are not run so return error */
                const message: string = `${result.stdout}\n${result.stderr}`;
                for (const child of testSuite.children) {
                    this.testStatesEmitter.fire({ type: 'test', test: child, state: 'errored', message: message } as TestEvent);
                }
            } else {
                /* Send the events from the xml report data */
                for (const ignoredTest of this.getTestListDataFromXmlReport(xmlReportData, "IgnoredTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: ignoredTest["Name"],
                        state: 'skipped',
                        message: result.stdout
                    } as TestEvent);
                }
                for (const succefullTest of this.getTestListDataFromXmlReport(xmlReportData, "SuccessfulTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: succefullTest["Name"],
                        state: 'passed',
                        message: result.stdout
                    } as TestEvent);
                }
                for (const failedTest of this.getTestListDataFromXmlReport(xmlReportData, "FailedTests")) {
                    this.testStatesEmitter.fire({
                        type: 'test',
                        test: failedTest["Name"],
                        state: 'failed',
                        message: result.stdout,
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

let g_debugTestExecutable: string = "";

export function getDebugTestExecutable(): string {
    return g_debugTestExecutable;
}
