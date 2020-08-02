import {
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Position,
	Range,
	Uri,
    languages
} from 'vscode';
import * as path from 'path';



export interface ProblemMatchingPattern {
    scanStdout: boolean;
    scanStderr: boolean;
    severity: string;
    filePrefix: string;
    regexp: string;
    message: number;
    file: number;
    line: number | null;
    lastLine: number | null;
    column: number | null;
    lastColumn: number | null;
}

interface FileDiagnostic {
    file: string;
    diagnostic: Diagnostic;
}



export class ProblemMatcher {
    private suitsDiagnostics: Map<string, Array<FileDiagnostic>>;
    private readonly diagnosticCollection: DiagnosticCollection;

    constructor() {
        this.suitsDiagnostics = new Map<string, Array<FileDiagnostic>>();
        this.diagnosticCollection = languages.createDiagnosticCollection('Ceedling');
    }

    private normalizePatterns(patterns: ProblemMatchingPattern[]): ProblemMatchingPattern[] {
        //I'm not a TypeScript expert, but it seems like VSCode has some bug:
        //"WorkspaceConfiguration.get<T>(section: string, defaultValue: T): T" could return anything,
        //requested type not matters. That's why I need to normalize it's output.
        let result: ProblemMatchingPattern[] = [];

        for (const pattern of patterns)
        {
            if ((pattern.regexp !== undefined) && (typeof pattern.regexp === 'string') &&
            (pattern.message !== undefined) && (typeof pattern.message === 'number') &&
            (pattern.file !== undefined) && (typeof pattern.file === 'number')) {
                let resultPattern: ProblemMatchingPattern = {
                    scanStdout: (pattern.scanStdout === true) ? true : false,
                    scanStderr: (pattern.scanStderr === false) ? false : true,
                    severity: ((pattern.severity === 'error') ||
                                (pattern.severity === 'warning') ||
                                (pattern.severity === 'info'))
                                ? pattern.severity : 'info',
                    filePrefix: ((pattern.filePrefix !== undefined) &&
                                            (typeof pattern.filePrefix === 'string'))
                                            ? pattern.filePrefix : '',
                    regexp: pattern.regexp,
                    message: pattern.message,
                    file: pattern.file,
                    line: ((pattern.line !== undefined) &&
                            (typeof pattern.line === 'number'))
                            ? pattern.line : null,
                    lastLine: ((pattern.lastLine !== undefined) &&
                            (typeof pattern.lastLine === 'number'))
                            ? pattern.lastLine : null,
                    column: ((pattern.column !== undefined) &&
                            (typeof pattern.column === 'number'))
                            ? pattern.column : null,
                    lastColumn: ((pattern.lastColumn !== undefined) &&
                            (typeof pattern.lastColumn === 'number'))
                            ? pattern.lastColumn : null
                };

                result.push(resultPattern);
            }
        }

        return result;
    }

    private getFileDiagnosticsFromRegexExec(matches: RegExpExecArray, file: number, message: number,
        severity: DiagnosticSeverity, filePrefix: string,
        line: number | null, lastLine: number | null, column: number | null, lastColumn: number | null
        ): FileDiagnostic | null {
        
        if ((matches.length < 3) ||
            (file >= matches.length) ||
            (message >= matches.length) ||
            ((line !== null) && (line >= matches.length)) ||
            ((lastLine !== null) && (lastLine >= matches.length)) ||
            ((column !== null) && (column >= matches.length)) ||
            ((lastColumn !== null) && (lastColumn >= matches.length))) {
            return null;
        }

        const fileValue = (filePrefix === '') ? matches[file] : path.resolve(filePrefix, matches[file]);
        const messageValue = matches[message];
        const lineValue = (line !== null) ? Number(matches[line]) : undefined;
        const lastLineValue = (lastLine !== null) ? Number(matches[lastLine]) : undefined;
        const columnValue = (column !== null) ? Number(matches[column]) : undefined;
        const lastColumnValue = (lastColumn !== null) ? Number(matches[lastColumn]) : undefined;
        
        if ((fileValue === undefined) ||
            (messageValue === undefined) ||
            ((lineValue !== undefined) && Number.isNaN(lineValue)) ||
            ((lastLineValue !== undefined) && Number.isNaN(lastLineValue)) ||
            ((columnValue !== undefined) && Number.isNaN(columnValue)) ||
            ((lastColumnValue !== undefined) && Number.isNaN(lastColumnValue))) {
            return null;
        }

        const range = new Range(
            new Position((lineValue !== undefined) ? lineValue - 1 : 0,
                        (columnValue !== undefined) ? columnValue - 1 : 0),
            new Position((lastLineValue !== undefined) ? lastLineValue - 1 :
                        ((lineValue !== undefined) ? lineValue - 1 : 0),
                        (lastColumnValue !== undefined) ? lastColumnValue - 1 : 999)
        );
        
        let resultDiagnostic = new Diagnostic(range, messageValue, severity);
        resultDiagnostic.source = 'Ceedling';

        return {
            file: fileValue,
            diagnostic: resultDiagnostic
        };
    }

    private getPatternDiagnostics(stdout: string, stderr: string, projectPath: string, pattern: ProblemMatchingPattern): FileDiagnostic[] {
        let result: FileDiagnostic[] = [];

		try {
            const input = ((pattern.scanStdout ? stdout : '') + '\n' + (pattern.scanStderr ? stderr : '')).split(/\r?\n/);
            const regexp = new RegExp(pattern.regexp);
            const severity = pattern.severity === 'error' ? DiagnosticSeverity.Error :
                            (pattern.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
            const filePrefix = pattern.filePrefix.replace(/\$\{projectPath\}/g, projectPath);
            for (const line of input) {
                const matches = regexp.exec(line);
                if (matches)
                {
                    const fileDiagnostic = this.getFileDiagnosticsFromRegexExec(matches, pattern.file, pattern.message, severity,
                                            filePrefix, pattern.line, pattern.lastLine, pattern.column, pattern.lastColumn);
                    if (fileDiagnostic !== null)
                    {
                        result.push(fileDiagnostic);
                    }
                }
            }
		} catch {
            //ignore
		}

        return result;
    }

    private compareDiagnostics(a: Diagnostic, b: Diagnostic): boolean {
        if ((a.message !== b.message) ||
            (a.severity !== b.severity) ||
            (a.range.start.line !== b.range.start.line) ||
            (a.range.start.character !== b.range.start.character) ||
            (a.range.end.line !== b.range.end.line) ||
            (a.range.end.character !== b.range.end.character) ||
            (a.source !== b.source))
        {
            return false;
        }

        return true;
    }
    
    private updateDiagnosticsCollection() {
        let fileDiagnosticsSets: Map<string, Array<Diagnostic>> = new Map<string, Array<Diagnostic>>();
        this.suitsDiagnostics.forEach((value: Array<FileDiagnostic>, key: string) => {
            for (const fileDiagnostic of value)
            {
                if (!fileDiagnosticsSets.has(fileDiagnostic.file))
                {
                    fileDiagnosticsSets.set(fileDiagnostic.file, new Array<Diagnostic>());
                }
                const diagnostics = fileDiagnosticsSets.get(fileDiagnostic.file)!;
                if (!diagnostics.some((value) => {
                    return this.compareDiagnostics(value, fileDiagnostic.diagnostic);
                }))
                {
                    diagnostics.push(fileDiagnostic.diagnostic);
                }
            }
        });
        this.diagnosticCollection.clear();
        fileDiagnosticsSets.forEach((value: Array<Diagnostic>, key: string) => {
            this.diagnosticCollection.set(Uri.file(key), value);
        });
    }

    scan(id: string, stdout: string, stderr: string, projectPath: string, patterns: ProblemMatchingPattern[]) {
        patterns = this.normalizePatterns(patterns);
        let allPatternsDiagnostics: FileDiagnostic[] = [];
        for (const pattern of patterns)
        {
            const patternDiagnostics = this.getPatternDiagnostics(stdout, stderr, projectPath, pattern);
            allPatternsDiagnostics = allPatternsDiagnostics.concat(patternDiagnostics);
        }
        this.suitsDiagnostics.set(id, allPatternsDiagnostics);
        this.updateDiagnosticsCollection();
    }

    setActualIds(actualIds: string[])
    {
        const currentIds = this.suitsDiagnostics.keys();
        for (const id of currentIds) {
            if (!actualIds.includes(id)) {
                this.suitsDiagnostics.delete(id);
            }
        }
        this.updateDiagnosticsCollection();
    }

    clear()
    {
        this.suitsDiagnostics.clear();
        this.diagnosticCollection.clear();
    }

    dispose(): void {
		this.clear();
		this.diagnosticCollection.dispose();
    }
}
