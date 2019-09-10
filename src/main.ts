import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CeedlingAdapter, getDebugTestExecutable } from './adapter';


function getCurrentDebugConfiguration(): string {
    const currentExec = getDebugTestExecutable();
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
                return new CeedlingAdapter(workspaceFolder);
            }
        ));
    }
}
