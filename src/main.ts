import vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { CeedlingAdapter } from './adapter';
import { Logger } from './logger';

const logger = new Logger();
let adapters: CeedlingAdapter[] = [];

function debugTestExecutable(): string | null {
    if (!adapters) return null;
    for (let adapter of adapters) {
        let debugTestExecutable = adapter.getDebugTestExecutable();
        if (debugTestExecutable) {
            return debugTestExecutable;
        }
    }
    logger.showError("No debug test executable found");
    logger.showInfo(
        "A debug configuration with a path containing `${command:ceedlingExplorer.debugTestExecutable}` " +
        "cannot be started from F5 or the Run pannel. It should be started from a bug icon in the Test pannel."
    );
    return null;
}

function debugTestExecutablePath(): string | null {
    if (!adapters) return null;
    for (let adapter of adapters) {
        let debugTestExecutablePath = adapter.getDebugTestExecutablePath();
        if (debugTestExecutablePath) {
            return debugTestExecutablePath;
        }
    }
    logger.showError("No debug test executable path found");
    logger.showInfo(
        "A debug configuration with a path containing `${command:ceedlingExplorer.debugTestExecutablePath}` " +
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
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.debugTestExecutablePath", debugTestExecutablePath));
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clean", ceedlingClean));
        context.subscriptions.push(vscode.commands.registerCommand("ceedlingExplorer.clobber", ceedlingClobber));
        context.subscriptions.push(logger);
        context.subscriptions.push(new TestAdapterRegistrar(
            testExplorerExtension.exports,
            workspaceFolder => {
                let adapter = new CeedlingAdapter(workspaceFolder, logger);
                adapters.push(adapter);
                return adapter;
            }
        ));
    }
}
