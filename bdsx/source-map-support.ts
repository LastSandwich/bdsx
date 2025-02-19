
import { SourceMapConsumer } from 'source-map';
import { anyToString, removeLine as removeLine } from './util';
import path = require('path');
import fs = require('fs');

interface StackState {
    nextPosition: Position | null;
    curPosition: Position | null;
}

interface UrlAndMap {
    url: string | null;
    map: string;
}

declare module 'source-map'
{
    interface SourceMapConsumer {
        sources: string[];
    }
}

interface SourceMapConsumerMap {
    url: string | null;
    map: SourceMapConsumer | null;
}

// Only install once if called multiple times
let uncaughtShimInstalled = false;

// Maps a file path to a string containing the file contents
const fileContentsCache: Record<string, string> = {};

// Maps a file path to a source map for that file
const sourceMapCache: Record<string, SourceMapConsumerMap | undefined> = {};

// Regex for detecting source maps
const reSourceMap = /^data:application\/json[^,]+base64,/;

// Priority list of retrieve handlers
const retrieveFileHandlers: ((path: string) => string)[] = [];
const retrieveMapHandlers: ((path: string) => UrlAndMap | null)[] = [];

function hasGlobalProcessEventEmitter(): boolean {
    return ((typeof process === 'object') && (process !== null) && (typeof process.on === 'function'));
}

function handlerExec<T, R>(list: ((arg: T) => R)[]): (arg: T) => R | null {
    return function (arg) {
        for (let i = 0; i < list.length; i++) {
            const ret = list[i](arg);
            if (ret) {
                return ret;
            }
        }
        return null;
    };
}

const retrieveFile = handlerExec(retrieveFileHandlers);

retrieveFileHandlers.push((path) => {
    // Trim the path to make sure there is no extra whitespace.
    path = path.trim();
    if (/^file:/.test(path)) {
        // existsSync/readFileSync can't handle file protocol, but once stripped, it works
        path = path.replace(/file:\/\/\/(\w:)?/, function (protocol, drive) {
            return drive ?
                '' : // file:///C:/dir/file -> C:/dir/file
                '/'; // file:///root-dir/file -> /root-dir/file
        });
    }
    if (path in fileContentsCache) {
        return fileContentsCache[path];
    }

    let contents = '';
    try {
        if (fs.existsSync(path)) {
            // Otherwise, use the filesystem
            contents = fs.readFileSync(path, 'utf8');
        }
    } catch (er) {
        /* ignore any errors */
    }

    return fileContentsCache[path] = contents;
});

// Support URLs relative to a directory, but be careful about a protocol prefix
// in case we are in the browser (i.e. directories may start with "http://" or "file:///")
function supportRelativeURL(file: string, url: string): string {
    if (!file) return url;
    const dir = path.dirname(file);
    const match = /^\w+:\/\/[^/]*/.exec(dir);
    let protocol = match ? match[0] : '';
    const startPath = dir.slice(protocol.length);
    if (protocol && /^\/\w:/.test(startPath)) {
        // handle file:///C:/ paths
        protocol += '/';
        return protocol + path.resolve(dir.slice(protocol.length), url).replace(/\\/g, '/');
    }
    return protocol + path.resolve(dir.slice(protocol.length), url);
}

function retrieveSourceMapURL(source: string):string|null {
    // Get the URL of the source map
    const fileData = retrieveFile(source);
    const re = /(?:\/\/[@#][\s]*sourceMappingURL=([^\s'"]+)[\s]*$)|(?:\/\*[@#][\s]*sourceMappingURL=([^\s*'"]+)[\s]*(?:\*\/)[\s]*$)/mg;
    // Keep executing the search to find the *last* sourceMappingURL to avoid
    // picking up sourceMappingURLs from comments, strings, etc.
    let lastMatch: RegExpMatchArray | null = null;
    let match: RegExpMatchArray | null;
    while ((match = re.exec(fileData!)) !== null) lastMatch = match;
    if (!lastMatch) return null;
    return lastMatch[1];
}

// Can be overridden by the retrieveSourceMap option to install. Takes a
// generated source filename; returns a {map, optional url} object, or null if
// there is no source map.  The map field may be either a string or the parsed
// JSON object (ie, it must be a valid argument to the SourceMapConsumer
// constructor).
export const retrieveSourceMap = handlerExec(retrieveMapHandlers);
retrieveMapHandlers.push(source => {
    let sourceMappingURL = retrieveSourceMapURL(source);
    if (!sourceMappingURL) return null;

    // Read the contents of the source map
    let sourceMapData: string | null;
    if (reSourceMap.test(sourceMappingURL)) {
        // Support source map URL as a data url
        const rawData = sourceMappingURL.slice(sourceMappingURL.indexOf(',') + 1);
        sourceMapData = Buffer.from(rawData, "base64").toString();
        sourceMappingURL = source;
    } else {
        // Support source map URLs relative to the source URL
        sourceMappingURL = supportRelativeURL(source, sourceMappingURL);
        sourceMapData = retrieveFile(sourceMappingURL!);
    }

    if (!sourceMapData) {
        return null;
    }

    return {
        url: sourceMappingURL!,
        map: sourceMapData
    };
});

interface Position {
    source: string;
    line: number;
    column: number;
}

export function mapSourcePosition(position: Position): Position {
    let sourceMap = sourceMapCache[position.source];

    if (!sourceMap) {
        // Call the (overrideable) retrieveSourceMap function to get the source map.
        const urlAndMap = retrieveSourceMap(position.source);
        if (urlAndMap) {
            sourceMap = sourceMapCache[position.source] = {
                url: urlAndMap.url,
                map: new SourceMapConsumer(urlAndMap.map as any)
            };

            // Load all sources stored inline with the source map into the file cache
            // to pretend like they are already loaded. They may not exist on disk.
            if (sourceMap.map) {
                sourceMap.map.sources.forEach(function (source, i) {
                    const contents = sourceMap!.map!.sourceContentFor(source);
                    if (contents) {
                        const url = supportRelativeURL(sourceMap!.url!, source);
                        fileContentsCache[url] = contents;
                    }
                });
            }
        } else {
            sourceMap = sourceMapCache[position.source] = {
                url: null,
                map: null
            };
        }
    }

    // Resolve the source URL relative to the URL of the source map
    if (sourceMap && sourceMap.map) {
        const originalPosition = sourceMap.map.originalPositionFor(position);

        // Only return the original position if a matching line was found. If no
        // matching line is found then we return position instead, which will cause
        // the stack trace to print the path and line for the compiled file. It is
        // better to give a precise location in the compiled file than a vague
        // location in the original file.

        if (originalPosition.source !== null) {
            originalPosition.source = supportRelativeURL(
                sourceMap.url!, originalPosition.source);
            return originalPosition;
        }
    }

    return position;
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin(origin: string): string {
    // Most eval() calls are in this format
    let match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
    if (match) {
        const position = mapSourcePosition({
            source: match[2],
            line: +match[3],
            column: +match[4] - 1
        });
        return `eval at ${match[1]} (${position.source}:${position.line}:${position.column + 1})`;
    }

    // Parse nested eval() calls using recursion
    match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
    if (match) {
        return `eval at ${match[1]} (${mapEvalOrigin(match[2])})`;
    }

    // Make sure we still return useful information if we didn't find anything
    return origin;
}

export function remapError<T extends Error>(err: T): T {
    err.stack = remapStack(err.stack);
    return err;
}

interface FrameInfo {
    stackLine: string;
    internal: boolean;
}

/**
 * remap filepath to original filepath
 */
export function remapStack(stack?: string): string | undefined {
    if (stack === undefined) return undefined;

    const state: StackState = { nextPosition: null, curPosition: null };
    const frames = stack.split('\n');
    let i = frames.length - 1;
    for (; i >= 1; i--) {
        const frame = remapStackLine(frames[i], state);
        if (frame.internal) continue;
        frames.length = i + 1;
        frames[i] = frame.stackLine;
        state.nextPosition = state.curPosition;
        break;
    }
    for (; i >= 1; i--) {
        const frame = remapStackLine(frames[i], state);
        frames[i] = frame.stackLine;
        state.nextPosition = state.curPosition;
    }
    return frames.join('\n');
}

/**
 * remap filepath to original filepath for one line
 */
export function remapStackLine(stackLine: string, state: StackState = { nextPosition: null, curPosition: null }): FrameInfo {

    const matched = /^ {3}at (.+) \(([^(]+)\)$/.exec(stackLine);
    if (!matched) return { stackLine, internal: false };
    const fnname = matched[1];
    const source = matched[2];

    // provides interface backward compatibility
    if (source === 'native code' || source === 'native code:0:0') {
        state.curPosition = null;
        return { stackLine, internal: false };
    }
    const srcmatched = /^(.+):(\d+):(\d+)$/.exec(source);
    if (!srcmatched) return { stackLine, internal: false };

    const isEval = fnname === 'eval code';
    if (isEval) {
        return { stackLine, internal: false };
    }

    const file = srcmatched[1];
    const line = +srcmatched[2];
    const column = +srcmatched[3] - 1;

    const position = mapSourcePosition({
        source: file,
        line: line,
        column: column
    });
    state.curPosition = position;
    return {
        stackLine: `   at ${fnname} (${position.source}:${position.line}:${position.column + 1})`,
        internal: position.source.startsWith('internal/')
    };
}

/**
 * remap stack and print
 */
export function remapAndPrintError(err:{stack?:string}): void {
    if (err && err.stack) {
        console.error(remapStack(err.stack));
    } else {
        console.error(err);
    }
}

// Generate position and snippet of original source with pointer
export function getErrorSource(error: Error): string | null {
    const match = /\n {3}at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack!);
    if (match) {
        const source = match[1];
        const line = +match[2];
        const column = +match[3];

        // Support the inline sourceContents inside the source map
        let contents = fileContentsCache[source];

        // Support files on disk
        if (!contents && fs && fs.existsSync(source)) {
            try {
                contents = fs.readFileSync(source, 'utf8');
            } catch (er) {
                contents = '';
            }
        }

        // Format the line from the original source code like node does
        if (contents) {
            const code = contents.split(/(?:\r\n|\r|\n)/)[line - 1];
            if (code) {
                return `${source}:${line}\n${code}\n${new Array(column).join(' ')}^`;
            }
        }
    }
    return null;
}

function printErrorAndExit(error: Error):void {
    const source = getErrorSource(error);

    // Ensure error is printed synchronously and not truncated
    const handle = (process.stderr as any)._handle;
    if (handle && handle.setBlocking) {
        handle.setBlocking(true);
    }

    if (source) {
        console.error();
        console.error(source);
    }

    console.error(error.stack);
    process.exit(1);
}

function shimEmitUncaughtException():void {
    const origEmit = process.emit;

    process.emit = function (type: string, ...args:any[]) {
        if (type === 'uncaughtException') {
            const err = args[0];
            const hasStack = (err && err.stack);
            const hasListeners = (this.listeners(type).length > 0);

            if (hasStack && !hasListeners) {
                err.stack = remapStack(err.stack);
                return printErrorAndExit(err);
            }
        } else if (type === 'unhandledRejection') {
            const err = args[0];
            err.stack = remapStack(err.stack);
        }

        return origEmit.apply(this, arguments);
    };
}

export function install():void {
    if (uncaughtShimInstalled) return;
    let installHandler = true;
    try {
        const worker_threads = module.require('worker_threads');
        if (worker_threads.isMainThread === false) {
            installHandler = false;
        }
    } catch (e) { }

    if (installHandler && hasGlobalProcessEventEmitter()) {
        uncaughtShimInstalled = true;
        shimEmitUncaughtException();
    }

    console.trace = function(...messages:any[]): void {
        const err = remapStack(removeLine(Error(messages.map(anyToString).join(' ')).stack || '', 1, 2))!;
        console.error(`Trace${err.substr(5)}`);
    };
}
