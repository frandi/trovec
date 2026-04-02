import * as vscode from 'vscode';
import { TrovecEditorProvider } from './trovecEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(TrovecEditorProvider.register(context));
}

export function deactivate(): void {
  // nothing to dispose
}
