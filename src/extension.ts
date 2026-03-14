import * as vscode from 'vscode';
import { PreviewProvider } from './previewProvider';

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  isWholeLine: true,
});

let isHighlighting = false;

export function activate(context: vscode.ExtensionContext) {
  const provider = new PreviewProvider();
  const scheme = 'annotate-ai-preview';

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, provider)
  );

  // Clear highlight when the user types
  vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isHighlighting) {
      editor.setDecorations(addedLineDecoration, []);
      isHighlighting = false;
    }
  });

  // --- FUNCTION 1: ADD AND HIGHLIGHT ---
  let addCommand = vscode.commands.registerCommand('annotate-ai.addAndHighlight', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // --- NEW: SAVE THE SNAPSHOT BEFORE EDITING ---
    const originalText = editor.document.getText();
    const previewUri = vscode.Uri.parse(`${scheme}:${editor.document.uri.path}`);
    provider.setSnapshot(previewUri, originalText); // This tells the provider what the "Left" side looks like
    // ----------------------------------------------

    const startLine = editor.document.lineCount;
    const codeToInsert = "\n\nfunction helloWorld() {\n  console.log('Hello!');\n}\n";

    await editor.edit((editBuilder) => {
      editBuilder.insert(new vscode.Position(startLine, 0), codeToInsert);
    });

    const endLine = editor.document.lineCount - 1;
    const range = new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, 0));

    editor.setDecorations(addedLineDecoration, [range]);

    // Delay setting this to true so the insert itself doesn't trigger the clear
    setTimeout(() => {
      isHighlighting = true;
    }, 100);
  });

  // --- FUNCTION 2: SHOW DIFF ---
  let diffCommand = vscode.commands.registerCommand('annotate-ai.showDiff', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor found');
      return;
    }

    const currentUri = editor.document.uri;
    const previewUri = vscode.Uri.parse(`${scheme}:${currentUri.path}`);

    // Check if we actually have a snapshot saved in the provider
    const originalText = provider.provideTextDocumentContent(previewUri);
    if (!originalText || originalText === '') {
      vscode.window.showWarningMessage('No previous state found. Run "Add Text" first.');
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      previewUri, // Left: Original
      currentUri, // Right: Modified
      'Annotate.ai: Changes'
    );
  });

  context.subscriptions.push(addCommand, diffCommand);
}