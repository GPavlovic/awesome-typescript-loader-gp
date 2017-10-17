import * as ts from 'typescript';
import * as path from 'path';
import * as micromatch from 'micromatch';
import * as colors from 'colors';
import { findResultFor, toUnix } from '../helpers';
import {
    Req,
    Res,
    LoaderConfig,
    CompilerInfo,
    Init,
    EmitFile,
    UpdateFile,
    Diagnostics,
    RemoveFile,
    Files,
    MessageType,
    TsConfig
} from './protocol';

import { CaseInsensitiveMap } from './fs';
import { isCaseInsensitive } from '../helpers';

const caseInsensitive = isCaseInsensitive();

if (!module.parent) {
    process.on('uncaughtException', function (err) {
        console.log("UNCAUGHT EXCEPTION in awesome-typescript-loader");
        console.log("[Inside 'uncaughtException' event] ", err.message, err.stack);
    });

    process.on("disconnect", function () {
        process.exit();
    });

    process.on("exit", () => {
        // console.log('EXIT RUNTIME');
    });

    createChecker(
        process.on.bind(process, "message"),
        process.send.bind(process)
    );
} else {
    module.exports.run = function run() {
        let send: (msg: Req, cb: (err?: Error) => void) => void;
        let receive = (msg) => { };

        createChecker(
            (receive: (msg: Req) => void) => {
                send = (msg: Req, cb: (err?: Error) => void) => {
                    receive(msg);
                    if (cb) { cb(); }
                };
            },
            (msg) => receive(msg)
        );

        return {
            on: (type: string, cb) => {
                if (type === "message") {
                    receive = cb;
                }
            },
            send,
            kill: () => { }
        };
    };
}

interface File {
    fileName: string;
    text: string;
    version: number;
    snapshot: ts.IScriptSnapshot;
}

type Filter = (file: ts.SourceFile) => boolean;

function createChecker(receive: (cb: (msg: Req) => void) => void, send: (msg: Res) => void) {
    let projectVersion = 0;
    let loaderConfig: LoaderConfig;
    let compilerConfig: TsConfig;
    let compilerOptions: ts.CompilerOptions;
    let webpackOptions: any;
    let compiler: typeof ts;
    let compilerInfo: CompilerInfo;
    let files = new CaseInsensitiveMap<File>();
    let host: ts.LanguageServiceHost;
    let service: ts.LanguageService;
    let ignoreDiagnostics: { [id: number]: boolean } = {};
    let instanceName: string;
    let context: string;

    function ensureFile(fileName: string) {
        const file = files.get(fileName);
        if (!file) {
            const text = compiler.sys.readFile(fileName);
            if (text) {
                files.set(fileName, {
                    fileName: fileName,
                    text,
                    version: 0,
                    snapshot: compiler.ScriptSnapshot.fromString(text)
                });
            }
        } else {
            if (file.fileName !== fileName) {
                if (caseInsensitive) {
                    file.fileName = fileName; // use most recent name for case-sensitive file systems
                    file.version++;
                    projectVersion++;
                } else {
                    removeFile(file.fileName);
                    projectVersion++;

                    const text = compiler.sys.readFile(fileName);
                    files.set(fileName, {
                        fileName,
                        text,
                        version: 0,
                        snapshot: compiler.ScriptSnapshot.fromString(text)
                    });
                    return;
                }
            }
        }
    }

    class FileDeps {
        files: { [fileName: string]: string[] } = {};

        add(containingFile: string, ...dep: string[]) {
            if (!this.files[containingFile]) {
                this.files[containingFile] = Array.from(dep);
            } else {
                const deps = this.files[containingFile];
                deps.push.apply(deps, dep);
            }
        }

        getDeps(containingFile: string): string[] {
            return this.files[containingFile] || [];
        }

        getAllDeps(containingFile: string, allDeps: { [key: string]: boolean } = {}, initial = true): string[] {
            const deps = this.getDeps(containingFile);
            deps.forEach(dep => {
                if (!allDeps[dep]) {
                    allDeps[dep] = true;
                    this.getAllDeps(dep, allDeps, false);
                }
            });

            if (initial) {
                return Object.keys(allDeps);
            } else {
                return [];
            }
        }
    }

    const fileDeps = new FileDeps();

    const TS_AND_JS_FILES = /\.tsx?$|\.jsx?$/i;
    const TS_FILES = /\.tsx?$/i;

    class Host implements ts.LanguageServiceHost {
        filesRegex: RegExp;
        getCustomTransformers = loaderConfig.getCustomTransformers;

        constructor(filesRegex: RegExp) {
            this.filesRegex = filesRegex;
        }

        getProjectVersion() { return projectVersion.toString(); }

        getScriptFileNames() {
            const names = files.map(file => file.fileName)
                .filter(fileName => this.filesRegex.test(fileName));
            return names;
        }

        getScriptVersion(fileName: string) {
            ensureFile(fileName);
            const file = files.get(fileName);
            if (file) {
                return file.version.toString();
            }
        }

        getScriptSnapshot(fileName: string) {
            ensureFile(fileName);
            const file = files.get(fileName);
            if (file) {
                return file.snapshot;
            }
        }

        getCurrentDirectory() {
            return context;
        }

        getScriptIsOpen() {
            return true;
        }

        getCompilationSettings() {
            return compilerOptions;
        }

        resolveTypeReferenceDirectives(typeDirectiveNames: string[], containingFile: string) {
            const resolved = typeDirectiveNames.map(directive =>
                compiler.resolveTypeReferenceDirective(directive, containingFile, compilerOptions, compiler.sys)
                    .resolvedTypeReferenceDirective);

            resolved.forEach(res => {
                if (res && res.resolvedFileName) {
                    fileDeps.add(containingFile, res.resolvedFileName);
                }
            });

            return resolved;
        }

        resolveModuleNames(moduleNames: string[], containingFile: string) {
            const resolved = moduleNames.map(module =>
                compiler.resolveModuleName(module, containingFile, compilerOptions, compiler.sys).resolvedModule);

            resolved.forEach(res => {
                if (res && res.resolvedFileName) {
                    fileDeps.add(containingFile, res.resolvedFileName);
                }
            });

            return resolved;
        }

        log(message) {
            console.log(message);
        }

        fileExists(...args) {
            return compiler.sys.fileExists.apply(compiler.sys, args);
        }

        readFile(...args) {
            return compiler.sys.readFile.apply(compiler.sys, args);
        }

        readDirectory(...args) {
            return compiler.sys.readDirectory.apply(compiler.sys, args);
        }

        getDefaultLibFileName(options: ts.CompilerOptions) {
            return compiler.getDefaultLibFilePath(options);
        }

        useCaseSensitiveFileNames() {
            return compiler.sys.useCaseSensitiveFileNames;
        }

        getDirectories(...args) {
            return compiler.sys.getDirectories.apply(compiler.sys, args);
        }

        directoryExists(path: string) {
            return compiler.sys.directoryExists(path);
        }

    }

    function processInit({ seq, payload }: Init.Request) {
        compiler = require(payload.compilerInfo.compilerPath);
        compilerInfo = payload.compilerInfo;
        loaderConfig = payload.loaderConfig;
        compilerConfig = payload.compilerConfig;
        compilerOptions = compilerConfig.options;
        webpackOptions = payload.webpackOptions;
        context = payload.context;

        instanceName = loaderConfig.instance || "at-loader";

        host = new Host(compilerOptions.allowJs
            ? TS_AND_JS_FILES
            : TS_FILES
        );

        service = compiler.createLanguageService(host);

        compilerConfig.fileNames.forEach(fileName => {
            let preferredFileName = getPreferredFilePath(fileName);
            let text: string = compiler.sys.readFile(preferredFileName);

            if (!text) { return; }
            files.set(fileName, {
                fileName,
                text,
                version: 0,
                snapshot: compiler.ScriptSnapshot.fromString(text)
            });
        });

        const program = service.getProgram();
        program.getSourceFiles().forEach(file => {
            files.set(file.fileName, {
                fileName: file.fileName,
                text: file.text,
                version: 0,
                snapshot: compiler.ScriptSnapshot.fromString(file.text)
            });
        });

        if (loaderConfig.debug) {
            console.log(`[${instanceName}] @DEBUG Initial files`, Object.keys(files));
        }

        if (loaderConfig.ignoreDiagnostics) {
            loaderConfig.ignoreDiagnostics.forEach(diag => {
                ignoreDiagnostics[diag] = true;
            });
        }

        replyOk(seq, null);
    }

    function updateFile(fileName: string, text: string, ifExist = false) {
        const preferredFileName = getPreferredFilePath(fileName);
        const nonPreferredFileName = getNonPreferredFilePath(fileName);
        const file = files.get(preferredFileName);
        if (file) {
            let updated = false;
            // If the file name does not match, but no preferred file was found
            if (file.fileName !== fileName
                && fileName === preferredFileName) {
                if (caseInsensitive) {
                    file.fileName = fileName; // use most recent name for case-sensitive file systems
                    updated = true;
                }
                // Only want to update the contents of the file if it has no preferred source
                else if (fileName === preferredFileName)
                {
                    removeFile(file.fileName);
                    projectVersion++;
                    files.set(fileName, {
                        fileName,
                        text,
                        version: 0,
                        snapshot: compiler.ScriptSnapshot.fromString(text)
                    });
                    return;
                }
                // If the preferred file was updated, need to update
                else if (fileName === preferredFileName
                        && fileName !== nonPreferredFileName)
                {
                    removeFile(file.fileName);
                    projectVersion++;
                    files.set(nonPreferredFileName, {
                        fileName: nonPreferredFileName,
                        text,
                        version: 0,
                        snapshot: compiler.ScriptSnapshot.fromString(text)
                    });
                    return;
                }
            }
            if (file.text !== text) { updated = updated || true; }
            if (!updated) {
                return;
            }
            projectVersion++;
            file.version++;
            file.text = text;
            file.snapshot = compiler.ScriptSnapshot.fromString(text);
        } else if (!ifExist) {
            projectVersion++;
            files.set(fileName, {
                fileName,
                text,
                version: 0,
                snapshot: compiler.ScriptSnapshot.fromString(text)
            });
        }
    }

    function removeFile(fileName: string) {
        if (files.has(fileName)) {
            files.delete(fileName);
            projectVersion++;
        }
    }

    function emit(fileName: string) {
        if (loaderConfig.useTranspileModule || loaderConfig.transpileOnly) {
            return fastEmit(fileName);
        } else {
            const output = service.getEmitOutput(fileName, false);
            if (output.outputFiles.length > 0) {
                return findResultFor(fileName, output);
            } else {
                // Use fast emit in case of errors
                return fastEmit(fileName);
            }
        }
    }

    function fastEmit(fileName: string) {
        const trans = compiler.transpileModule(files.get(fileName).text, {
            compilerOptions: compilerOptions,
            fileName,
            reportDiagnostics: false
        });

        return {
            text: trans.outputText,
            sourceMap: trans.sourceMapText
        };
    }

    function processUpdate({ seq, payload }: UpdateFile.Request) {
        updateFile(payload.fileName, payload.text, payload.ifExist);
        replyOk(seq, null);
    }

    function processRemove({ seq, payload }: RemoveFile.Request) {
        removeFile(payload.fileName);
        replyOk(seq, null);
    }

    function processEmit({ seq, payload }: EmitFile.Request) {
        updateFile(payload.fileName, payload.text);
        const emitResult = emit(payload.fileName);
        const deps = fileDeps.getAllDeps(payload.fileName);

        replyOk(seq, { emitResult, deps });
    }

    function processFiles({ seq }: Files.Request) {
        replyOk(seq, {
            files: service.getProgram().getSourceFiles().map(f => f.fileName)
        });
    }

    function processDiagnostics({ seq }: Diagnostics.Request) {
        let silent = !!loaderConfig.silent;

        if (!silent) {
            console.log(colors.cyan(`\n[${instanceName}] Checking started in a separate process...`));
        }

        const program = service.getProgram();

        const allDiagnostics = program
            .getOptionsDiagnostics()
            .concat(program.getGlobalDiagnostics());

        const filters: Filter[] = [];

        if (compilerConfig.options.skipLibCheck) {
            filters.push(file => {
                return !file.isDeclarationFile;
            });
        }

        if (loaderConfig.reportFiles) {
            filters.push(file => {
                const fileName = path.relative(context, file.fileName);
                return micromatch(fileName, loaderConfig.reportFiles).length > 0;
            });
        }

        let nativeGetter: () => ts.SourceFile[];
        if (filters.length > 0) {
            nativeGetter = program.getSourceFiles;
            program.getSourceFiles = () => nativeGetter().filter(file => {
                return filters.every(f => f(file));
            });
        }

        allDiagnostics.push(...program.getSyntacticDiagnostics());
        allDiagnostics.push(...program.getSemanticDiagnostics());

        if (loaderConfig.debug) {
            console.log(`[${instanceName}] @DEBUG Typechecked files`, program.getSourceFiles());
        }

        if (nativeGetter) {
            program.getSourceFiles = nativeGetter;
        }

        const processedDiagnostics = allDiagnostics
            .filter(diag => !ignoreDiagnostics[diag.code])
            .map(diagnostic => {
                const message = compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
                let fileName = diagnostic.file && path.relative(context, diagnostic.file.fileName);

                if (fileName && fileName[0] !== ".") {
                    fileName = "./" + toUnix(fileName);
                }

                let pretty = "";
                let line = 0;
                let character = 0;
                let code = diagnostic.code;

                if (diagnostic.file) {
                    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                    line = pos.line;
                    character = pos.character;
                    pretty = (`[${instanceName}] ${colors.red(fileName)}:${line + 1}:${character + 1} \n    TS${code}: ${colors.red(message)}`);
                } else {
                    pretty = (colors.red(`[${instanceName}] TS${code}: ${message}`));
                }

                return {
                    category: diagnostic.category,
                    code: diagnostic.code,
                    fileName,
                    start: diagnostic.start,
                    message,
                    pretty,
                    line,
                    character
                };
            });

        replyOk(seq, processedDiagnostics);
    }

    function replyOk(seq: number, payload: any) {
        send({
            seq,
            success: true,
            payload
        } as Res);
    }

    function replyErr(seq: number, payload: any) {
        send({
            seq,
            success: false,
            payload
        } as Res);
    }

    function getPreferredFilePath(filePath: string): string
    {
        // We have been provided a preferred file prefix
        if (loaderConfig.preferredFilePrefix)
        {
            let filePathArray = filePath.split("/");
            // Do not want to process deps
            if (!filePathArray.some(x => x == "node_modules"))
            {
                // Alter the file path by adding a prefix folder, and adding a prefix to the filename
                filePathArray[filePathArray.length - 1] = loaderConfig.preferredFilePrefix + "." + filePathArray[filePathArray.length - 1];
                // Rejoin to get the new file path
                let preferredFilePath = filePathArray.join("/");
                // Check if the preferred path exists
                if (compiler.sys.fileExists(preferredFilePath))
                {
                    // Load the preferred file
                    return preferredFilePath;
                    // console.log("\nPREFERRED FILE CONTENTS " + preferredFilePath + ": " + text + "\n");
                }
            }
        }
        return filePath;
    }

    function getNonPreferredFilePath(filePath: string): string
    {
        if (!loaderConfig.preferredFilePrefix)
        {
            return filePath;
        }
        let filePathArray = filePath.split("/");
        // Alter the file path by adding a prefix folder, and adding a prefix to the filename
        if (filePathArray[filePathArray.length - 1].startsWith(loaderConfig.preferredFilePrefix + "."))
        {
            // Get the original file name.
            let fileName = filePathArray.pop().slice(loaderConfig.preferredFilePrefix.length + 1);
            // Add the original filename back
            filePathArray.push(fileName);
            return filePathArray.join("/");
        }
        return filePath;
    }

    receive(function (req: Req) {
        try {
            switch (req.type) {
                case MessageType.Init:
                    processInit(req);
                    break;
                case MessageType.RemoveFile:
                    processRemove(req);
                    break;
                case MessageType.UpdateFile:
                    processUpdate(req);
                    break;
                case MessageType.EmitFile:
                    processEmit(req);
                    break;
                case MessageType.Diagnostics:
                    processDiagnostics(req);
                    break;
                case MessageType.Files:
                    processFiles(req);
                    break;

            }
        } catch (e) {
            console.error(`[${instanceName}]: Child process failed to process the request: `, e);
            replyErr(req.seq, null);
        }
    });
}
