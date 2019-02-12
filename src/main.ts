import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CeedlingAdapter } from './adapter';

let currentAdapter: CeedlingAdapter | null = null;

function getCurrentDebugConfiguration(): string {
    const currentExec = currentAdapter != null ? currentAdapter!.debugTestExecutable : "";
    if (!currentExec) {
        vscode.window.showErrorMessage("Not currently debugging a Ceedling Test");
        return "";
    }
    return currentExec;
}

export async function activate(context: vscode.ExtensionContext) {
    const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
    if (testExplorerExtension) {
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.debugTestExecutable", getCurrentDebugConfiguration));
        context.subscriptions.push(new TestAdapterRegistrar(
            testExplorerExtension.exports,
            workspaceFolder => {
                currentAdapter = new CeedlingAdapter(workspaceFolder);
                return currentAdapter;
            }
        ));
    }
}
