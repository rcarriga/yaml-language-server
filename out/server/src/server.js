'use strict';
const vscode_languageserver_1 = require("vscode-languageserver");
const request_light_1 = require("request-light");
const yaml_ast_parser_beta_1 = require("yaml-ast-parser-beta");
const yamlLanguageService_1 = require("./languageService/yamlLanguageService");
const Strings = require("./languageService/utils/strings");
const uri_1 = require("./languageService/utils/uri");
const URL = require("url");
const fs = require("fs");
const languageModelCache_1 = require("./languageModelCache");
const yamlParser_1 = require("./languageService/parser/yamlParser");
const vscode_json_languageservice_1 = require("vscode-json-languageservice");
const arrUtils_1 = require("./languageService/utils/arrUtils");
var glob = require('glob');
var VSCodeContentRequest;
(function (VSCodeContentRequest) {
    VSCodeContentRequest.type = new vscode_languageserver_1.RequestType('vscode/content');
})(VSCodeContentRequest || (VSCodeContentRequest = {}));
const validationDelayMs = 200;
let pendingValidationRequests = {};
// Create a connection for the server.
let connection = null;
if (process.argv.indexOf('--stdio') == -1) {
    connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
}
else {
    connection = vscode_languageserver_1.createConnection();
}
// Create a simple text document manager. The text document manager
// supports full document sync only
let documents = new vscode_languageserver_1.TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
let workspaceRoot;
connection.onInitialize((params) => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            hoverProvider: true,
            documentSymbolProvider: true,
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: vscode_languageserver_1.TextDocumentSyncKind.Full,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true
            }
        }
    };
});
let workspaceContext = {
    resolveRelativePath: (relativePath, resource) => {
        return URL.resolve(resource, relativePath);
    }
};
let schemaRequestService = (uri) => {
    if (Strings.startsWith(uri, 'file://')) {
        let fsPath = uri_1.default.parse(uri).fsPath;
        return new Promise((c, e) => {
            fs.readFile(fsPath, 'UTF-8', (err, result) => {
                err ? e('') : c(result.toString());
            });
        });
    }
    else if (Strings.startsWith(uri, 'vscode://')) {
        return connection.sendRequest(VSCodeContentRequest.type, uri).then(responseText => {
            return responseText;
        }, error => {
            return error.message;
        });
    }
    return request_light_1.xhr({ url: uri, followRedirects: 5 }).then(response => {
        return response.responseText;
    }, (error) => {
        return Promise.reject(error.responseText || request_light_1.getErrorStatusDescription(error.status) || error.toString());
    });
};
let filesToIgnore = [];
let k8sSchemaOn = true;
let kedgeSchemaOn = false;
let languageService = yamlLanguageService_1.getLanguageService(schemaRequestService, workspaceContext, true, false);
let jsonLanguageService = vscode_json_languageservice_1.getLanguageService(schemaRequestService);
connection.onDidChangeConfiguration((change) => {
    let settings = change.settings;
    filesToIgnore = settings.k8s.filesNotValidating || [];
    k8sSchemaOn = settings.k8s.k8sSchemaOn;
    kedgeSchemaOn = settings.k8s.kedgeSchemaOn;
    languageService = yamlLanguageService_1.getLanguageService(schemaRequestService, workspaceContext, k8sSchemaOn, kedgeSchemaOn);
    validateFilesNotInSetting();
});
function clearDiagnostics() {
    documents.all().forEach(doc => {
        connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    });
}
function validateFilesNotInSetting() {
    clearDiagnostics();
    documents.all().forEach(doc => {
        triggerValidation(doc);
    });
}
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    if (change.document.getText().length === 0)
        connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
    triggerValidation(change.document);
});
documents.onDidClose((event => {
    cleanPendingValidation(event.document);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
}));
function docIsValid(doc) {
    let docUriFileTypeRemoved = doc.uri.split("//").pop();
    return filesToIgnore.indexOf(docUriFileTypeRemoved) === -1;
}
function triggerValidation(textDocument) {
    cleanPendingValidation(textDocument);
    pendingValidationRequests[textDocument.uri] = setTimeout(() => {
        delete pendingValidationRequests[textDocument.uri];
        validateTextDocument(textDocument);
    }, validationDelayMs);
}
function cleanPendingValidation(textDocument) {
    let request = pendingValidationRequests[textDocument.uri];
    if (request) {
        clearTimeout(request);
        delete pendingValidationRequests[textDocument.uri];
    }
}
function validateTextDocument(textDocument) {
    let yDoc = yaml_ast_parser_beta_1.load(textDocument.getText(), {});
    if (yDoc !== undefined) {
        let diagnostics = [];
        if (yDoc.errors.length != 0) {
            diagnostics = yDoc.errors.map(error => {
                let mark = error.mark;
                return {
                    severity: vscode_languageserver_1.DiagnosticSeverity.Error,
                    range: {
                        start: textDocument.positionAt(mark.position),
                        end: { line: error.mark.line, character: error.mark.column }
                    },
                    message: error.reason,
                    source: "k8s"
                };
            });
        }
        if (docIsValid(textDocument)) {
            let yamlDoc = yaml_ast_parser_beta_1.load(textDocument.getText(), {});
            languageService.doValidation(textDocument, yamlDoc).then(function (result) {
                for (let x = 0; x < result.items.length; x++) {
                    diagnostics.push(result.items[x]);
                }
                // Send the computed diagnostics to VSCode.
                connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
            });
        }
        else {
            connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        }
    }
}
// This handler provides the initial list of the completion items.
connection.onCompletion(textDocumentPosition => {
    let document = documents.get(textDocumentPosition.textDocument.uri);
    if (docIsValid(document)) {
        return completionHelper(document, textDocumentPosition);
    }
    return [];
});
function completionHelper(document, textDocumentPosition) {
    /*
    * THIS IS A HACKY VERSION.
    * Needed to get the parent node from the current node to support live autocompletion
    */
    //Get the string we are looking at via a substring
    let linePos = textDocumentPosition.position.line;
    let position = textDocumentPosition.position;
    let lineOffset = arrUtils_1.getLineOffsets(document.getText());
    let start = lineOffset[linePos]; //Start of where the autocompletion is happening
    let end = 0; //End of where the autocompletion is happening
    if (lineOffset[linePos + 1]) {
        end = lineOffset[linePos + 1];
    }
    else {
        end = document.getText().length;
    }
    let textLine = document.getText().substring(start, end);
    //Check if the string we are looking at is a node
    if (textLine.indexOf(":") === -1) {
        //We need to add the ":" to load the nodes
        let newText = "";
        //This is for the empty line case
        if (textLine.trim().length === 0) {
            //Add a temp node that is in the document but we don't use at all.
            if (lineOffset[linePos + 1]) {
                newText = document.getText().substring(0, start + (textLine.length - 1)) + "holder:\r\n" + document.getText().substr(end + 2);
            }
            else {
                newText = document.getText().substring(0, start + (textLine.length)) + "holder:\r\n" + document.getText().substr(end + 2);
            }
        }
        else {
            //Add a semicolon to the end of the current line so we can validate the node
            if (lineOffset[linePos + 1]) {
                newText = document.getText().substring(0, start + (textLine.length - 1)) + ":\r\n" + document.getText().substr(end + 2);
            }
            else {
                newText = document.getText().substring(0, start + (textLine.length)) + ":\r\n" + document.getText().substr(end + 2);
            }
        }
        let yamlDoc = yaml_ast_parser_beta_1.load(newText, {});
        return languageService.doComplete(document, position, yamlDoc);
    }
    else {
        //All the nodes are loaded
        let yamlDoc = yaml_ast_parser_beta_1.load(document.getText(), {});
        position.character = position.character - 1;
        return languageService.doComplete(document, position, yamlDoc);
    }
}
// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    return item;
});
let yamlDocuments = languageModelCache_1.getLanguageModelCache(10, 60, document => yamlParser_1.parse(document.getText()));
documents.onDidClose(e => {
    yamlDocuments.onDocumentRemoved(e.document);
});
connection.onShutdown(() => {
    yamlDocuments.dispose();
});
function getJSONDocument(document) {
    return yamlDocuments.get(document);
}
connection.onHover(params => {
    let document = documents.get(params.textDocument.uri);
    let yamlDoc = yaml_ast_parser_beta_1.load(document.getText(), {});
    return languageService.doHover(document, params.position, yamlDoc).then((hoverItem) => {
        return hoverItem;
    });
});
connection.onDocumentSymbol(params => {
    let document = documents.get(params.textDocument.uri);
    let jsonDocument = getJSONDocument(document);
    return jsonLanguageService.findDocumentSymbols(document, jsonDocument);
});
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map