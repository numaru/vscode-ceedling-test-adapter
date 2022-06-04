import vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CeedlingAdapter } from './adapter';

let adapters: CeedlingAdapter[] = [];

function debugTestExecutable(): string | null {
    if (!adapters) return null;
    for (let adapter of adapters) {
        let debugTestExecutable = adapter.getDebugTestExecutable();
        if (debugTestExecutable) {
            return debugTestExecutable;
        }
    }
    vscode.window.showErrorMessage("No debug test executable found");
    vscode.window.showInformationMessage(
        "A debug configuration with a path containing `${command:ceedlingExplorer.debugTestExecutable}` " +
        "cannot be started from F5 or the Run pannel. It should be started from a bug icon in the Test pannel."
    );
    return null;
}

function ceedlingClean(): void {
    if (!adapters) return;
    for (let adapter of adapters) {
        adapter.clean();
    }
}

function ceedlingClobber(): void {
    if (!adapters) return;
    for (let adapter of adapters) {
        adapter.clobber();
    }
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
                let adapter = new CeedlingAdapter(workspaceFolder);
                adapters.push(adapter);
                return adapter;
            }
        ));
    }
}
