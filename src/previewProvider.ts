import * as vscode from 'vscode';

export class PreviewProvider implements vscode.TextDocumentContentProvider {
    private _content = new Map<string, string>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._content.get(uri.path) || '';
    }

    setSnapshot(uri: vscode.Uri, text: string) {
        this._content.set(uri.path, text);
    }
}