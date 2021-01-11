import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CeedlingAdapter } from './adapter';

let currentAdapter: CeedlingAdapter | null = null

function debugTestExecutable(): string | null {
    if (currentAdapter == null) return null;
    const currentExec = currentAdapter.getDebugTestExecutable();
    if (!currentExec) {
        vscode.window.showErrorMessage("No debug test executable found");
        vscode.window.showInformationMessage(
            "A debug configuration with a path containing `${command:ceedlingExplorer.debugTestExecutable}` " +
            "cannot be started from F5 or the Run pannel. It should be started from a bug icon in the Test pannel."
        );
        return null;
    }
    return currentExec;
}

function ceedlingClean(): void {
    if (currentAdapter == null) return;
    currentAdapter.clean();
}

function ceedlingClobber(): void {
    if (currentAdapter == null) return;
    currentAdapter.clobber();
}

export async function activate(context: vscode.ExtensionContext) {
    const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
    if (testExplorerExtension) {
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.debugTestExecutable", debugTestExecutable));
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clean", ceedlingClean));
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clobber", ceedlingClobber));
        context.subscriptions.push(new TestAdapterRegistrar(
            testExplorerExtension.exports,
            workspaceFolder => {
                currentAdapter = new CeedlingAdapter(workspaceFolder);
                return currentAdapter;
            }
        ));
    }
}
