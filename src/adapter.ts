import * as child_process from 'child_process';
import * as async_mutex from 'async-mutex';
import * as tree_kill from 'tree-kill';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as xml2js from 'xml2js';
import opn = require('opn');
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
    private watchedFileForAutorunList: string[] = [];
    private watchedFileForReloadList: string[] = [];
    private testSuiteInfo: TestSuiteInfo = {
        type: 'suite',
        id: 'root',
        label: 'Ceedling',
        children: []
    };
    private isCanceled: boolean = false;
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
    }

    async load(): Promise<void> {
        this.testsEmitter.fire({ type: 'started' } as TestLoadStartedEvent);

        await this.sanityCheck();

        const assemblyFiles = await this.getFileList('assembly');
        const headerFiles = await this.getFileList('header');
        const sourceFiles = await this.getFileList('source');
        const testFiles = await this.getFileList('test');
        
        this.watchFilesForAutorun(assemblyFiles);
        this.watchFilesForAutorun(headerFiles);
        this.watchFilesForAutorun(sourceFiles);
        this.watchFilesForAutorun(testFiles);

        this.watchFilesForReload(testFiles);

        const ymlProjectData = await this.getYmlProjectData();
        if (ymlProjectData) {
            this.setFunctionRegex(ymlProjectData);
            this.watchFilesForReload([this.getYmlProjectPath()]);
        }

        await this.setTestSuiteInfo(testFiles);

        this.testsEmitter.fire({ type: 'finished', suite: this.testSuiteInfo } as TestLoadFinishedEvent);
    }

    async run(testIds: string[]): Promise<void> {
        const testSuites = this.getTestSuitesFromTestIds(testIds);
        this.testStatesEmitter.fire({
            type: 'started',
            tests: testSuites.map((test) => {
                return test.id;
            }
        )} as TestRunStartedEvent);
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
        throw new Error("Method not implemented.");
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

    private async sanityCheck() {
        const ymlProjectData = await this.getYmlProjectData();
        if (ymlProjectData) {
            try {
                if (!ymlProjectData[':plugins'][':enabled'].includes('xml_tests_report')) {
                    throw 'Xml report plugin not enabled';
                }
            } catch (e) {
                vscode.window.showErrorMessage(
                    `The required Ceedling plugin 'xml_tests_report' is not enabled.` +
                    `You have to edit your 'project.xml' file to enable the plugin.`,
                    'Open Ceedling documentation'
                ).then((message) => {
                    if (message === 'Open Ceedling documentation') {
                        opn(
                            'https://github.com/ThrowTheSwitch/Ceedling/blob/master/docs/CeedlingPacket.md' +
                            '#tool-element-runtime-substitution-notational-substitution'
                        )
                    }
                });
            }
        }
    }

    private getConfiguration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration('ceedlingExplorer', this.workspaceFolder.uri);
    }

    private getProjectPath(): string {
        const defaultProjectPath = '.';
        const projectPath = this.getConfiguration().get<string>('projectPath', defaultProjectPath);
        return path.resolve(
            this.workspaceFolder.uri.fsPath,
            projectPath !== "null" ? projectPath : defaultProjectPath
        );
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
                    return value.substr(3);
                })
            }
        } finally {
            release();
        }
    }

    private execCeedling(args: ReadonlyArray<string>): Promise<any> {
        return new Promise<any>((resolve) => {
            this.ceedlingProcess = child_process.exec(
                `ceedling ${args}`,
                { cwd: this.getProjectPath() },
                (error, stdout, stderr) => {
                    resolve({error, stdout, stderr});
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
                testPrefix = ymlProjectData[':unity'][':test_prefix'];
            } catch (e) {}
        }
        this.functionRegex = new RegExp(
            `^((?:\\s*TEST_CASE\\s*\\(.*?\\)\\s*)*)\\s*void\\s+((?:${testPrefix}).*)\\s*\\(\\s*(.*)\\s*\\)`,
            'gm'
        );
    }

    private getTestFunctionRegex(): RegExp {
        if (!this.functionRegex) {
            this.setFunctionRegex();
        }
        return this.functionRegex as RegExp;
    }

    private setTestSuiteInfo(files: string[]) {
        this.testSuiteInfo = {
            type: 'suite',
            id: 'root',
            label: 'Ceedling',
            children: []
        } as TestSuiteInfo;
        for (const file of files) {
            const fullPath = path.resolve(this.getProjectPath(), file);
            const currentTestSuitInfo: TestSuiteInfo = {
                type: 'suite',
                id: file,
                label: file,
                file: fullPath,
                children: []
            };
            const testRegex = this.getTestFunctionRegex();
            const fileText = fs.readFileSync(fullPath, 'utf8');
            let match = testRegex.exec(fileText);
            while (match != null) {
                const testName = match[2];
                const line = fileText.substr(0, match.index).split('\n').length;
                currentTestSuitInfo.children.push({
                    type: 'test',
                    id: file + '::' + testName,
                    label: testName,
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
            'build', 'artifacts', 'test', 'report.xml'
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
        const parser = new xml2js.Parser({ explicitArray : false });
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
            const result = await this.execCeedling([`test:${testSuite.file}`]);
            const xmlReportData = await this.getXmlReportData();
            if (xmlReportData === undefined) {
                /* The tests are not run so return fail */
                const message: string = `${result.stdout}\n${result.stderr}`;
                for (const child of testSuite.children) {
                    this.testStatesEmitter.fire({ type: 'test', test: child, state: 'failed', message: message } as TestEvent);
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
