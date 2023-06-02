/*
 * Copyright 2023 The Kythe Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview This module contains implementation of IndexerHost interface.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {VName} from './kythe';
import {CompilationUnit, Context, IndexerHost, IndexingOptions, LANGUAGE, TSNamespace} from './plugin_api';
import * as utf8 from './utf8';
import {isStaticMember, todo} from './util';


/**
 * stripExtension strips the .d.ts, .ts or .tsx extension from a path.
 * It's used to map a file path to the module name.
 */
export function stripExtension(path: string): string {
  return path.replace(/\.(d\.)?tsx?$/, '');
}

/**
 * Determines if a node is a variable-like declaration.
 *
 * TODO(https://github.com/microsoft/TypeScript/issues/33115): Replace this with
 * a native `ts.isHasExpressionInitializer` if TypeScript ever adds it.
 */
function hasExpressionInitializer(node: ts.Node):
    node is ts.HasExpressionInitializer {
  return ts.isVariableDeclaration(node) || ts.isParameter(node) ||
      ts.isBindingElement(node) || ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) ||
      ts.isEnumMember(node);
}

type NamespaceAndContext = string&{__brand: 'nsctx'};

/**
 * A SymbolVNameStore stores a mapping of symbols to the (many) VNames it may
 * have. Each TypeScript symbol can be be of a different TypeScript namespace
 * and be declared in a unique context, leading to a total (`TSNamespace` *
 * `Context`) number of possible VNames for the symbol.
 *
 *              TSNamespace + Context
 *              -----------   -------
 *              TYPE          Any
 * ts.Symbol -> VALUE         Getter  -> VName
 *              NAMESPACE     Setter
 *                            ...
 *
 * The `Any` context makes no guarantee of symbol declaration disambiguation.
 * As a result, unless explicitly set for a given symbol and namespace, the
 * VName of an `Any` context is lazily set to the VName of an arbitrary context.
 */
class SymbolVNameStore {
  private readonly store =
      new Map<ts.Symbol, Map<NamespaceAndContext, Readonly<VName>>>();

  /**
   * Serializes a namespace and context as a string to lookup in the store.
   *
   * Each instance of a JavaScript object is unique, so using one as a key fails
   * because a new object would be generated every time the store is queried.
   */
  private serialize(ns: TSNamespace, context: Context): NamespaceAndContext {
    return `${ns}${context}` as NamespaceAndContext;
  }

  /** Get a symbol VName for a given namespace and context, if it exists. */
  get(symbol: ts.Symbol, ns: TSNamespace, context: Context): VName|undefined {
    if (this.store.has(symbol)) {
      const nsCtx = this.serialize(ns, context);
      return this.store.get(symbol)!.get(nsCtx);
    }
    return undefined;
  }

  /**
   * Set a symbol VName for a given namespace and context. Throws if a VName
   * already exists.
   */
  set(symbol: ts.Symbol, ns: TSNamespace, context: Context, vname: VName) {
    let vnameMap = this.store.get(symbol);
    const nsCtx = this.serialize(ns, context);
    if (vnameMap) {
      if (vnameMap.has(nsCtx)) {
        throw new Error(`VName already set with signature ${
            vnameMap.get(nsCtx)!.signature}`);
      }
      vnameMap.set(nsCtx, vname);
    } else {
      this.store.set(symbol, new Map([[nsCtx, vname]]));
    }

    // Set the symbol VName for the given namespace and `Any` context, if it has
    // not already been set.
    const nsAny = this.serialize(ns, Context.Any);
    vnameMap = this.store.get(symbol)!;
    if (!vnameMap.has(nsAny)) {
      vnameMap.set(nsAny, vname);
    }
  }
}

/**
 * StandardIndexerContext provides the standard definition of information about
 * a TypeScript program and common methods used by the TypeScript indexer and
 * its plugins. See the IndexerContext interface definition for more details.
 */
export class StandardIndexerContext implements IndexerHost {
  private offsetTables = new Map<string, utf8.OffsetTable>();

  /** A shorter name for the rootDir in the CompilerOptions. */
  private sourceRoot: string;

  /**
   * rootDirs is the list of rootDirs in the compiler options, sorted
   * longest first.  See this.moduleName().
   */
  private rootDirs: string[];

  /** symbolNames is a store of ts.Symbols to their assigned VNames. */
  private symbolNames = new SymbolVNameStore();

  /**
   * anonId increments for each anonymous block, to give them unique
   * signatures.
   */
  private anonId = 0;

  /**
   * anonNames maps nodes to the anonymous names assigned to them.
   */
  private anonNames = new Map<ts.Node, string>();

  private typeChecker: ts.TypeChecker;

  constructor(
      public readonly program: ts.Program,
      public readonly compilationUnit: CompilationUnit,
      public readonly options: IndexingOptions) {
    this.sourceRoot =
        this.program.getCompilerOptions().rootDir || process.cwd();
    let rootDirs =
        this.program.getCompilerOptions().rootDirs || [this.sourceRoot];
    rootDirs = rootDirs.map(d => d + '/');
    rootDirs.sort((a, b) => b.length - a.length);
    this.rootDirs = rootDirs;
    this.typeChecker = this.program.getTypeChecker();
  }

  getOffsetTable(path: string): Readonly<utf8.OffsetTable> {
    let table = this.offsetTables.get(path);
    if (!table) {
      const buf = (this.options.readFile || fs.readFileSync)(path);
      table = new utf8.OffsetTable(buf);
      this.offsetTables.set(path, table);
    }
    return table;
  }

  getSymbolAtLocation(node: ts.Node): ts.Symbol|undefined {
    return this.typeChecker.getSymbolAtLocation(node);
  }

  getSymbolAtLocationFollowingAliases(node: ts.Node): ts.Symbol|undefined {
    let sym = this.typeChecker.getSymbolAtLocation(node);
    while (sym && (sym.flags & ts.SymbolFlags.Alias) > 0) {
      // a hack to prevent following aliases in cases like:
      // import * as fooNamespace from './foo';
      // here fooNamespace is an alias for the 'foo' module.
      // We don't want to follow it so that users can easier usages
      // of fooNamespace in the file.
      const decl = sym.declarations?.[0];
      if (decl && ts.isNamespaceImport(decl)) {
        break;
      }

      sym = this.typeChecker.getAliasedSymbol(sym);
    }
    return sym;
  }

  /**
   * anonName assigns a freshly generated name to a Node.
   * It's used to give stable names to e.g. anonymous objects.
   */
  anonName(node: ts.Node): string {
    let name = this.anonNames.get(node);
    if (!name) {
      name = `anon${this.anonId++}`;
      this.anonNames.set(node, name);
    }
    return name;
  }

  /**
   * scopedSignature computes a scoped name for a ts.Node.
   * E.g. if you have a function `foo` containing a block containing a variable
   * `bar`, it might return a VName like
   *   signature: "foo.block0.bar""
   *   path: <appropriate path to module>
   */
  scopedSignature(startNode: ts.Node): VName {
    let moduleName: string|undefined;
    const parts: string[] = [];

    // Traverse the containing blocks upward, gathering names from nodes that
    // introduce scopes.
    for (let node: ts.Node|undefined = startNode,
                   lastNode: ts.Node|undefined = undefined;
         node != null; lastNode = node, node = node.parent) {
      // Nodes that are rvalues of a named initialization should not introduce a
      // new scope. For instance, in `const a = class A {}`, `A` should
      // contribute nothing to the scoped signature.
      if (node.parent && hasExpressionInitializer(node.parent) &&
          node.parent.name.kind === ts.SyntaxKind.Identifier) {
        continue;
      }

      switch (node.kind) {
        case ts.SyntaxKind.ExportAssignment:
          const exportDecl = node as ts.ExportAssignment;
          if (!exportDecl.isExportEquals) {
            // It's an "export default" statement.
            // This is semantically equivalent to exporting a variable
            // named 'default'.
            parts.push('default');
          } else {
            parts.push('export=');
          }
          break;
        case ts.SyntaxKind.ArrowFunction:
          // Arrow functions are anonymous, so generate a unique id.
          parts.push(`arrow${this.anonId++}`);
          break;
        case ts.SyntaxKind.FunctionExpression:
          // Function expressions look like
          //   (function() {})
          // which have no name but introduce an anonymous scope.
          parts.push(`func${this.anonId++}`);
          break;
        case ts.SyntaxKind.Block:
          // Blocks need their own scopes for contained variable declarations.
          if (node.parent &&
              (node.parent.kind === ts.SyntaxKind.FunctionDeclaration ||
               node.parent.kind === ts.SyntaxKind.MethodDeclaration ||
               node.parent.kind === ts.SyntaxKind.Constructor ||
               node.parent.kind === ts.SyntaxKind.ForStatement ||
               node.parent.kind === ts.SyntaxKind.ForInStatement ||
               node.parent.kind === ts.SyntaxKind.ForOfStatement)) {
            // A block that's an immediate child of the above node kinds
            // already has a scoped name generated by that parent.
            // (It would be fine to not handle this specially and just fall
            // through to the below code, but avoiding it here makes the names
            // simpler.)
            continue;
          }
          parts.push(`block${this.anonId++}`);
          break;
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
          // Introduce a naming scope for all variables declared within the
          // statement, so that the two 'x's declared here get different names:
          //   for (const x in y) { ... }
          //   for (const x in y) { ... }
          parts.push(`for${this.anonId++}`);
          break;
        case ts.SyntaxKind.BindingElement:
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.ClassExpression:
        case ts.SyntaxKind.EnumDeclaration:
        case ts.SyntaxKind.EnumMember:
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.InterfaceDeclaration:
        case ts.SyntaxKind.ImportEqualsDeclaration:
        case ts.SyntaxKind.ImportSpecifier:
        case ts.SyntaxKind.ExportSpecifier:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.NamespaceImport:
        case ts.SyntaxKind.ObjectLiteralExpression:
        case ts.SyntaxKind.Parameter:
        case ts.SyntaxKind.PropertyAccessExpression:
        case ts.SyntaxKind.PropertyAssignment:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.TypeAliasDeclaration:
        case ts.SyntaxKind.TypeParameter:
        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.ShorthandPropertyAssignment:
          const decl = node as ts.NamedDeclaration;
          if (decl.name) {
            switch (decl.name.kind) {
              case ts.SyntaxKind.Identifier:
              case ts.SyntaxKind.StringLiteral:
              case ts.SyntaxKind.NumericLiteral:
              case ts.SyntaxKind.ComputedPropertyName:
              case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
                let part;
                if (ts.isComputedPropertyName(decl.name)) {
                  const sym =
                      this.getSymbolAtLocationFollowingAliases(decl.name);
                  part = sym ? sym.name : this.anonName(decl.name);
                } else {
                  part = decl.name.text;
                }
                // Wrap literals in quotes, so that characters used in other
                // signatures do not interfere with the signature created by a
                // literal. For instance, a literal
                //   obj.prop
                // may interefere with the signature of `prop` on an object
                // `obj`. The literal receives a signature
                //   "obj.prop"
                // to avoid this.
                if (ts.isStringLiteral(decl.name)) {
                  part = `"${part}"`;
                }
                // Instance members of a class are scoped to the type of the
                // class.
                if (ts.isClassDeclaration(decl) && lastNode !== undefined &&
                    ts.isClassElement(lastNode) &&
                    !isStaticMember(lastNode, decl) &&
                    // special case constructor. We want it to no have
                    // #type modifier as constructor will have the same name
                    // as class.
                    !ts.isConstructorDeclaration(startNode)) {
                  part += '#type';
                }
                // Getters and setters semantically refer to the same entities
                // but are declared differently, so they are differentiated.
                if (ts.isGetAccessor(decl)) {
                  part += ':getter';
                } else if (ts.isSetAccessor(decl)) {
                  part += ':setter';
                }
                parts.push(part);
                break;
              default:
                // Skip adding an anonymous scope for variables declared in an
                // array or object binding pattern like `const [a] = [0]`.
                break;
            }
          } else {
            parts.push(this.anonName(node));
          }
          break;
        case ts.SyntaxKind.Constructor:
          // Class members declared with a shorthand in the constructor should
          // be scoped to the class, not the constructor.
          if (!ts.isParameterPropertyDeclaration(startNode, startNode.parent) &&
              startNode !== node) {
            parts.push('constructor');
          }
          break;
        case ts.SyntaxKind.ImportClause:
          // An import clause can have one of two forms:
          //   import foo from './bar';
          //   import {foo as far} from './bar';
          // In the first case the clause has a name "foo". In this case add the
          // name of the clause to the signature.
          // In the second case the clause has no explicit name. This
          // contributes nothing to the signature without risk of naming
          // conflicts because TS imports are essentially file-global lvalues.
          const importClause = node as ts.ImportClause;
          if (importClause.name) {
            parts.push(importClause.name.text);
          }
          break;
        case ts.SyntaxKind.ModuleDeclaration:
          const modDecl = node as ts.ModuleDeclaration;
          if (modDecl.name.kind === ts.SyntaxKind.StringLiteral) {
            // Syntax like:
            //   declare module 'foo/bar' {}
            // This is the syntax for defining symbols in another, named
            // module.
            moduleName = (modDecl.name as ts.StringLiteral).text;
          } else if (modDecl.name.kind === ts.SyntaxKind.Identifier) {
            // Syntax like:
            //   declare module foo {}
            // without quotes is just an obsolete way of saying 'namespace'.
            parts.push((modDecl.name as ts.Identifier).text);
          }
          break;
        case ts.SyntaxKind.SourceFile:
          // moduleName can already be set if the target was contained within
          // a "declare module 'foo/bar'" block (see the handling of
          // ModuleDeclaration).  Otherwise, the module name is derived from the
          // name of the current file.
          if (!moduleName) {
            moduleName = this.moduleName((node as ts.SourceFile).fileName);
          }
          break;
        case ts.SyntaxKind.JsxElement:
        case ts.SyntaxKind.JsxSelfClosingElement:
        case ts.SyntaxKind.JsxAttribute:
          // Given a unique anonymous name to all JSX nodes. This prevents
          // conflicts in cases where attributes would otherwise have the same
          // name, like `src` in
          //   <img src={a} />
          //   <img src={b} />
          parts.push(`jsx${this.anonId++}`);
          break;
        default:
          // Most nodes are children of other nodes that do not introduce a
          // new namespace, e.g. "return x;", so ignore all other parents
          // by default.
          // TODO: namespace {}, etc.
          // If the node is actually some subtype that has a 'name' attribute
          // and it's not empty it's likely this function should have handled
          // it. Dynamically probe for this case and warn if we missed one.
          if ((node as any).name != null) {
            todo(
                this.sourceRoot, node,
                `scopedSignature: ${ts.SyntaxKind[node.kind]} ` +
                    `has unused 'name' property`);
          }
      }
    }

    // The names were gathered from bottom to top, so reverse before joining.
    const signature = parts.reverse().join('.');
    return Object.assign(
        this.pathToVName(moduleName!), {signature, language: LANGUAGE});
  }

  /**
   * getSymbolName computes the VName of a ts.Symbol. A Context can be
   * optionally specified to help disambiguate nodes with multiple declarations.
   * See the documentation of Context for more information.
   */
  getSymbolName(
      sym: ts.Symbol, ns: TSNamespace, context: Context = Context.Any): VName
      |undefined {
    const stored = this.symbolNames.get(sym, ns, context);
    if (stored) return stored;

    if (!sym.declarations || sym.declarations.length < 1) {
      return undefined;
    }

    let declarations = sym.declarations;
    // Disambiguate symbols with multiple declarations using a context.
    if (sym.declarations.length > 1) {
      switch (context) {
        case Context.Getter:
          declarations = declarations.filter(ts.isGetAccessor);
          break;
        case Context.Setter:
          declarations = declarations.filter(ts.isSetAccessor);
          break;
        default:
          break;
      }
    }

    const decl = declarations[0];
    const vname = this.scopedSignature(decl);
    // The signature of a value is undecorated.
    // The signature of a type has the #type suffix.
    // The signature of a namespace has the #namespace suffix.
    if (ns === TSNamespace.TYPE) {
      vname.signature += '#type';
    } else if (ns === TSNamespace.NAMESPACE) {
      vname.signature += '#namespace';
    } else if (ns === TSNamespace.TYPE_MIGRATION) {
      vname.signature += '#mtype';
    }

    // Cache the VName for future lookups.
    this.symbolNames.set(sym, ns, context, vname);
    return vname;
  }

  /**
   * moduleName returns the ES6 module name of a path to a source file.
   * E.g. foo/bar.ts and foo/bar.d.ts both have the same module name,
   * 'foo/bar', and rootDirs (like bazel-bin/) are eliminated.
   * See README.md for a discussion of this.
   */
  moduleName(sourcePath: string): string {
    // Compute sourcePath as relative to one of the rootDirs.
    // This canonicalizes e.g. bazel-bin/foo to just foo.
    // Note that this.rootDirs is sorted longest first, so we'll use the
    // longest match.
    for (const rootDir of this.rootDirs) {
      if (sourcePath.startsWith(rootDir)) {
        sourcePath = path.relative(rootDir, sourcePath);
        break;
      }
    }
    return stripExtension(sourcePath);
  }

  /**
   * pathToVName returns the VName for a given file path.
   *
   * This function is used for 2 distinct cases that should be ideally separated
   * in 2 different functions. `path` can be one of two:
   * 1. Full path like 'bazel-out/genfiles/path/to/file.ts'.
   *    This path is used to build VNames for files and anchors.
   * 2. Module name like 'path/to/file'.
   *    This path is used to build VNames for semantic nodes.
   *
   * Only for full paths `pathVnames` contains an entry. For short paths (module
   * names) this function will defaults to calculating vname based on path
   * and compilation unit.
   */
  pathToVName(path: string): VName {
    const vname = this.compilationUnit.fileVNames.get(path);
    return {
      signature: '',
      language: '',
      corpus: vname && vname.corpus ? vname.corpus :
                                      this.compilationUnit.rootVName.corpus,
      root: vname && vname.corpus ? vname.root :
                                    this.compilationUnit.rootVName.root,
      path: vname && vname.path ? vname.path : path,
    };
  }
}
