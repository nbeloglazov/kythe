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
 * @fileoverview Various util functions that are used across multiple modules.
 */

import * as path from 'path';
import * as ts from 'typescript';

/**
 * Determines if a node is a static member of a class.
 */
export function isStaticMember(node: ts.Node, klass: ts.Declaration): boolean {
  return ts.isPropertyDeclaration(node) && node.parent === klass &&
      ((ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) > 0);
}

/**
 * Logs a TODO message to the console together with the location of the node.
 * Useful to mark places in the code that have unexpected or unimplemented
 * cases.
 */
export function todo(sourceRoot: string, node: ts.Node, message: string) {
  const sourceFile = node.getSourceFile();
  const file = path.relative(sourceRoot, sourceFile.fileName);
  const {line, character} =
      ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
  console.warn(`TODO: ${file}:${line}:${character}: ${message}`);
}
