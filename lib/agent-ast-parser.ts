import * as ts from 'typescript';

/**
 * Extract the largest TypeScript code block from LLM output.
 * Handles cases where LLM includes prose, multiple code blocks, or markdown.
 */
export function extractLargestCodeBlock(text: string): string {
  // Pattern to match code blocks: ```typescript...``` or ```ts...``` or ```...```
  const codeBlockPattern = /```(?:typescript|ts)?\n?([\s\S]*?)```/g;
  const matches: string[] = [];

  let match;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    matches.push(match[1].trim());
  }

  if (matches.length > 0) {
    // Return the largest code block (most likely to be the full agent)
    return matches.reduce((a, b) => a.length > b.length ? a : b);
  }

  // No code blocks found - try to extract code by looking for common patterns
  // Look for content between imports and the last export
  const importMatch = text.match(/^(import\s+.*?from\s+['"].*?['"];?\s*)+/);
  const exportMatch = text.match(/export\s+(?:const|default)\s+\w+.*?;/);

  if (importMatch || exportMatch) {
    const startIdx = importMatch ? text.indexOf(importMatch[0]) : 0;
    const endIdx = exportMatch
      ? text.indexOf(exportMatch[0]) + exportMatch[0].length
      : text.length;
    return text.slice(startIdx, endIdx).trim();
  }

  // Last resort: return the original text stripped of obvious prose markers
  return text
    .replace(/^(Here is|Here's|The following|This is|Below is)[^\n]*/i, '')
    .replace(/\n\n(Note:|Explanation:|This code|This agent)[^]*/i, '')
    .trim();
}

export interface ParsedOperator {
  name: string;
  type: string;
  description: string;
}

export interface PipelineAnalysis {
  name: string;
  description: string;
  operators: ParsedOperator[];
  sourceCode: string;
}

const EVALUATOR_DESCRIPTIONS: Record<string, string> = {
  parseMarkdownForVoice: 'Parses markdown for voice output',
  generateVoice: 'Generates voice audio',
  analyzeSentiment: 'Analyzes sentiment',
  detectToolCalls: 'Detects tool calls',
  detectTools: 'Detects tool calls',
  executeTools: 'Executes tools',
  createEvaluator: 'Creates LLM evaluator',
  createLLMChunkEvaluator: 'LLM completion',
  completeTurnWithLLM: 'LLM response generation',
  processWithEvaluator: 'Processes with evaluator',
  generateImage: 'Generates image via ComfyUI',
  convertToMp3: 'Converts audio to MP3',
  transcribeAudio: 'Transcribes audio to text'
};

function getEvaluatorDescription(name: string): string {
  if (EVALUATOR_DESCRIPTIONS[name]) return EVALUATOR_DESCRIPTIONS[name];
  for (const [key, desc] of Object.entries(EVALUATOR_DESCRIPTIONS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return desc;
  }
  return name;
}

// Track evaluator variables in scope
class EvaluatorScope {
  private variables: Map<string, string> = new Map(); // varName -> evaluatorName
  private arrays: Map<string, string[]> = new Map(); // varName -> array values

  addVariable(name: string, evaluatorName: string) {
    this.variables.set(name, evaluatorName);
  }

  getEvaluator(name: string): string | undefined {
    return this.variables.get(name);
  }

  hasVariable(name: string): boolean {
    return this.variables.has(name);
  }

  addArray(name: string, values: string[]) {
    this.arrays.set(name, values);
  }

  getArray(name: string): string[] | undefined {
    return this.arrays.get(name);
  }
}

export function analyzeAgentPipeline(code: string): PipelineAnalysis {
  const sourceFile = ts.createSourceFile(
    'agent.ts',
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const result: PipelineAnalysis = {
    name: 'Unknown Pipeline',
    description: '',
    operators: [],
    sourceCode: code
  };

  const scope = new EvaluatorScope();

  // Extract agent name and description
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableDeclaration(node) && 
        node.type?.getText(sourceFile).includes('AgentDefinition')) {
      result.name = node.name.getText(sourceFile);
      
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          if (ts.isPropertyAssignment(prop) && 
              prop.name.getText(sourceFile) === 'description' &&
              ts.isStringLiteral(prop.initializer)) {
            result.description = prop.initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  // First pass: find all evaluator variable assignments and array declarations
  function findEvaluatorVariables(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const varName = node.name.getText(sourceFile);
      
      // const x = evaluatorName({...})
      if (ts.isCallExpression(node.initializer)) {
        const callName = node.initializer.expression.getText(sourceFile);
        if (EVALUATOR_DESCRIPTIONS[callName]) {
          scope.addVariable(varName, callName);
        }
      }
      
      // const x = ['a', 'b', 'c'] - collect array literals
      if (ts.isArrayLiteralExpression(node.initializer)) {
        const values: string[] = [];
        for (const element of node.initializer.elements) {
          if (ts.isStringLiteral(element)) {
            values.push(element.text);
          }
        }
        if (values.length > 0) {
          scope.addArray(varName, values);
        }
      }
    }
    ts.forEachChild(node, findEvaluatorVariables);
  }
  ts.forEachChild(sourceFile, findEvaluatorVariables);

  // Second pass: find pipe chains and collect them in order
  const pipeOperators: ParsedOperator[] = [];
  const subscribeOperators: ParsedOperator[] = [];
  
  function findPipesAndSubscribes(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      
      // Process pipe chains first - but still traverse into them for nested calls
      if (exprText === 'pipe' || exprText.endsWith('.pipe')) {
        const pipeOps = extractOperators(node, sourceFile, scope);
        pipeOperators.push(...pipeOps);
        // Continue traversing to find any subscribes in pipe arguments
      }
      
      // Collect subscribe handlers separately (they come after pipe)
      // But first traverse into the expression (which may contain the pipe chain)
      if (exprText === 'subscribe' || exprText.endsWith('.subscribe')) {
        // First traverse into the expression part (e.g., the pipe chain)
        if (ts.isPropertyAccessExpression(node.expression)) {
          ts.forEachChild(node.expression, findPipesAndSubscribes);
        }
        // Then extract evaluators from the subscribe handler
        const handlerOps = extractSubscribeEvaluators(node, sourceFile, scope);
        subscribeOperators.push(...handlerOps);
        // Don't traverse into subscribe handler arguments (already processed)
        return;
      }
    }
    ts.forEachChild(node, findPipesAndSubscribes);
  }
  ts.forEachChild(sourceFile, findPipesAndSubscribes);
  
  // Combine: pipe operators first, then subscribe handlers
  result.operators = [...pipeOperators, ...subscribeOperators];

  return result;
}

function extractOperators(
  pipeCall: ts.CallExpression, 
  sourceFile: ts.SourceFile, 
  scope: EvaluatorScope
): ParsedOperator[] {
  const operators: ParsedOperator[] = [];

  for (const arg of pipeCall.arguments) {
    const op = parseOperator(arg, sourceFile, scope);
    if (op) operators.push(op);
  }

  return operators;
}

function parseOperator(
  node: ts.Node, 
  sourceFile: ts.SourceFile, 
  scope: EvaluatorScope
): ParsedOperator | null {
  // Handle catchError - skip it
  if (ts.isCallExpression(node)) {
    const funcName = node.expression.getText(sourceFile);
    if (funcName === 'catchError') return null;
  }

  // filter((chunk) => condition)
  if (ts.isCallExpression(node) && 
      node.expression.getText(sourceFile) === 'filter') {
    return parseFilter(node.arguments[0], sourceFile);
  }

  // map((chunk) => transform)
  if (ts.isCallExpression(node) && 
      node.expression.getText(sourceFile) === 'map') {
    return parseMap(node.arguments[0], sourceFile);
  }

  // mergeMap/switchMap/concatMap
  if (ts.isCallExpression(node)) {
    const funcName = node.expression.getText(sourceFile);
    if (['mergeMap', 'switchMap', 'concatMap'].includes(funcName)) {
      return parseMapOperator(funcName, node.arguments[0], sourceFile, scope);
    }
  }

  // tap
  if (ts.isCallExpression(node) && 
      node.expression.getText(sourceFile) === 'tap') {
    return {
      name: 'tap',
      type: 'Side Effect',
      description: 'Performs side effect'
    };
  }

  // Direct evaluator references like detectToolCalls()
  if (ts.isCallExpression(node) && node.arguments.length === 0) {
    const name = node.expression.getText(sourceFile);
    const desc = getEvaluatorDescription(name);
    if (desc !== name) {
      return {
        name,
        type: 'Custom Evaluator',
        description: desc
      };
    }
  }

  return null;
}

function parseMapOperator(
  funcName: string,
  arg: ts.Node,
  sourceFile: ts.SourceFile,
  scope: EvaluatorScope
): ParsedOperator {
  const text = arg.getText(sourceFile);
  const foundEvaluators: string[] = [];
  let toolsList: string[] | undefined;

  // Walk the AST to find all function calls
  function findCalls(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callName = node.expression.getText(sourceFile);

      // Check if this is a variable that holds an evaluator
      if (scope.hasVariable(callName)) {
        const evaluatorName = scope.getEvaluator(callName);
        if (evaluatorName) {
          foundEvaluators.push(evaluatorName);
        }
      }

      // Check for direct evaluator calls
      if (EVALUATOR_DESCRIPTIONS[callName]) {
        foundEvaluators.push(callName);

        // Special handling for executeTools - extract the tools list
        if (callName === 'executeTools' && node.arguments.length > 0) {
          const firstArg = node.arguments[0];
          if (ts.isObjectLiteralExpression(firstArg)) {
            // Look for tools: property
            for (const prop of firstArg.properties) {
              if (ts.isPropertyAssignment(prop) && prop.name.getText(sourceFile) === 'tools') {
                // Check if it's an identifier (reference to an array variable)
                if (ts.isIdentifier(prop.initializer)) {
                  const arrayName = prop.initializer.getText(sourceFile);
                  toolsList = scope.getArray(arrayName);
                }
                // Check if it's a direct array literal
                else if (ts.isArrayLiteralExpression(prop.initializer)) {
                  toolsList = [];
                  for (const element of prop.initializer.elements) {
                    if (ts.isStringLiteral(element)) {
                      toolsList.push(element.text);
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Check for session.createEvaluator pattern
      if (callName.startsWith('session.')) {
        const method = callName.split('.')[1];
        if (EVALUATOR_DESCRIPTIONS[method]) {
          foundEvaluators.push(method);
        }
      }
    }
    ts.forEachChild(node, findCalls);
  }
  findCalls(arg);

  // Check for completeTurnWithLLM
  const hasLLM = text.includes('completeTurnWithLLM');
  if (hasLLM) {
    foundEvaluators.push('completeTurnWithLLM');
  }

  if (foundEvaluators.length === 0) {
    return {
      name: funcName,
      type: 'Async Transform',
      description: 'Maps to async operation'
    };
  }

  // Deduplicate
  const unique = [...new Set(foundEvaluators)];
  const descriptions = unique.map(e => getEvaluatorDescription(e));

  // Add tools list to description if found
  let description = descriptions.join(', ');
  if (toolsList && toolsList.length > 0) {
    description += ` [tools: ${toolsList.join(', ')}]`;
  }

  return {
    name: funcName,
    type: foundEvaluators.includes('completeTurnWithLLM') && unique.length === 1 ? 'LLM Call' : 'Custom Evaluator',
    description
  };
}

function extractSubscribeEvaluators(
  subscribeCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
  scope: EvaluatorScope
): ParsedOperator[] {
  const operators: ParsedOperator[] = [];
  const foundEvaluators: Set<string> = new Set();

  // Look through subscribe arguments for evaluator calls
  function findEvaluatorsInSubscribe(node: ts.Node) {
    // Check for call expressions
    if (ts.isCallExpression(node)) {
      // Case 1: Direct call like transcribeAudio(...)
      if (ts.isIdentifier(node.expression)) {
        const callName = node.expression.getText(sourceFile);
        if (EVALUATOR_DESCRIPTIONS[callName]) {
          foundEvaluators.add(callName);
        }
        // Check if this is a variable that holds an evaluator
        if (scope.hasVariable(callName)) {
          const evaluatorName = scope.getEvaluator(callName);
          if (evaluatorName) {
            foundEvaluators.add(evaluatorName);
          }
        }
      }
      
      // Case 2: Curried call like transcribeAudio(...)(...)
      // The node.expression is itself a CallExpression
      if (ts.isCallExpression(node.expression)) {
        if (ts.isIdentifier(node.expression.expression)) {
          const innerCallName = node.expression.expression.getText(sourceFile);
          if (EVALUATOR_DESCRIPTIONS[innerCallName]) {
            foundEvaluators.add(innerCallName);
          }
        }
      }
      
      // Case 3: Method call like x.subscribe(...)
      if (ts.isPropertyAccessExpression(node.expression)) {
        const propName = node.expression.name.getText(sourceFile);
        // Recurse into nested subscribes too
        if (propName === 'subscribe') {
          for (const arg of node.arguments) {
            findEvaluatorsInSubscribe(arg);
          }
        }
      }
    }
    
    // Continue searching all children
    ts.forEachChild(node, findEvaluatorsInSubscribe);
  }

  for (const arg of subscribeCall.arguments) {
    findEvaluatorsInSubscribe(arg);
  }

  // Create operators for each found evaluator in subscribe
  for (const evaluatorName of foundEvaluators) {
    operators.push({
      name: evaluatorName,
      type: 'Custom Evaluator',
      description: getEvaluatorDescription(evaluatorName)
    });
  }

  return operators;
}

function parseFilter(arg: ts.Node, sourceFile: ts.SourceFile): ParsedOperator {
  const text = arg.getText(sourceFile);
  
  if (text.includes('contentType')) {
    const match = text.match(/contentType\s*===?\s*['"]([^'"]+)['"]/);
    return {
      name: 'filter',
      type: 'Type Filter',
      description: match ? `Only ${match[1]} content` : 'Filters content type'
    };
  }
  
  if (text.includes('trust')) {
    return {
      name: 'filter',
      type: 'Security Filter',
      description: 'Trusted content only'
    };
  }

  if (text.includes('chat.role')) {
    const match = text.match(/chat\.role\s*===?\s*['"]([^'"]+)['"]/);
    return {
      name: 'filter',
      type: 'Role Filter',
      description: match ? `Only ${match[1]} messages` : 'Filters by role'
    };
  }

  return {
    name: 'filter',
    type: 'Condition Filter',
    description: text.length > 40 ? text.slice(0, 40) + '...' : text
  };
}

function parseMap(arg: ts.Node, sourceFile: ts.SourceFile): ParsedOperator {
  const text = arg.getText(sourceFile);

  if (text.includes('annotateChunk')) {
    const match = text.match(/annotateChunk\([^,]+,\s*['"]([^'"]+)['"]/);
    return {
      name: 'map',
      type: 'Annotation',
      description: match ? `Sets ${match[1]}` : 'Adds annotation'
    };
  }

  return {
    name: 'map',
    type: 'Transform',
    description: text.length > 40 ? text.slice(0, 40) + '...' : text
  };
}
