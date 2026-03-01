/**
 * Agent Code Parser
 * Utilities for parsing and analyzing ObservableCAFE agent TypeScript code.
 */

/**
 * Analyzed pipeline structure
 */
export interface PipelineAnalysis {
  name: string;
  description: string;
  operators: ParsedOperator[];
  sourceCode: string;
}

/**
 * Parsed operator information
 */
export interface ParsedOperator {
  name: string;
  type: string;
  description: string;
}

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

/**
 * Analyze agent code to extract pipeline information for visualization
 */
export function analyzeAgentPipeline(code: string): PipelineAnalysis {
  const pipeline: PipelineAnalysis = {
    name: 'Unknown Pipeline',
    description: '',
    operators: [],
    sourceCode: code
  };

  // Extract agent name from export statement
  const nameMatch = code.match(/export\s+const\s+(\w+):\s*AgentDefinition/);
  if (nameMatch) {
    pipeline.name = nameMatch[1];
  }

  // Extract description from JSDoc or agent definition
  const descMatch = code.match(/description:\s*['"]([^'"]+)['"]/);
  if (descMatch) {
    pipeline.description = descMatch[1];
  }

  // Parse the pipe chain to extract meaningful operations
  const pipeMatch = code.match(/\.pipe\(([\s\S]*?)\)\s*\.subscribe/);
  if (pipeMatch) {
    const pipeContent = pipeMatch[1];
    const operators = parsePipeContent(pipeContent);
    pipeline.operators = operators;
  }

  return pipeline;
}

/**
 * Parse pipe content to extract meaningful operations
 */
export function parsePipeContent(content: string): ParsedOperator[] {
  const operators: ParsedOperator[] = [];

  // Split by top-level commas (not inside parentheses)
  const parts = splitPipeParts(content);

  for (const part of parts) {
    const op = parseOperator(part.trim());
    if (op) {
      operators.push(op);
    }
  }

  return operators;
}

/**
 * Split pipe content by top-level commas
 */
export function splitPipeParts(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of content) {
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current);
  }

  return parts;
}

/**
 * Parse a single operator call
 */
export function parseOperator(part: string): ParsedOperator | null {
  part = part.trim();

  // Skip subscribe and other terminal operations
  if (part.startsWith('subscribe') || part.startsWith('catchError')) {
    return null;
  }

  // Extract function calls like filter(...), map(...), mergeMap(...)
  const funcMatch = part.match(/^(\w+)\s*\((.*)\)$/s);
  if (!funcMatch) {
    // Check for custom evaluators passed directly
    if (part.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
      return {
        name: part,
        type: 'Custom Evaluator',
        description: getEvaluatorDescription(part)
      };
    }
    return null;
  }

  const [, funcName, args] = funcMatch;

  // Parse based on operator type
  switch (funcName) {
    case 'filter':
      return parseFilter(args);
    case 'map':
      return parseMap(args);
    case 'mergeMap':
    case 'switchMap':
    case 'concatMap':
      return parseMapOperator(funcName, args);
    case 'tap':
      return parseTap(args);
    case 'debounceTime':
    case 'throttleTime':
      return {
        name: funcName,
        type: 'Timing Control',
        description: `Waits ${args}ms before processing`
      };
    case 'distinctUntilChanged':
      return {
        name: funcName,
        type: 'Deduplication',
        description: 'Ignores consecutive duplicate values'
      };
    default:
      // Check if it's a custom evaluator function
      if (args === '' || args === 'session') {
        return {
          name: funcName,
          type: 'Custom Evaluator',
          description: getEvaluatorDescription(funcName)
        };
      }
      return {
        name: funcName,
        type: 'RxJS Operator',
        description: getOperatorDescription(funcName)
      };
  }
}

/**
 * Parse filter operator to extract condition
 */
export function parseFilter(args: string): ParsedOperator {
  // Clean up the arguments
  const cleanArgs = args.replace(/\s+/g, ' ').trim();

  // Extract condition from arrow function
  const arrowMatch = cleanArgs.match(/\([^)]*\)\s*=>\s*(.+)/);
  if (arrowMatch) {
    const condition = arrowMatch[1].trim();

    // Check for combined conditions
    const hasContentType = condition.includes('contentType');
    const hasTrust = condition.includes('trust');
    const hasChatRole = condition.includes('chat.role');
    const conditionCount = [hasContentType, hasTrust, hasChatRole].filter(Boolean).length;

    // Parse common filter patterns
    if (hasContentType) {
      const typeMatch = condition.match(/contentType\s*===?\s*['"]([^'"]+)['"]/);
      if (typeMatch) {
        const baseDesc = `Only ${typeMatch[1]} content`;
        // If combined with role filter
        if (hasChatRole) {
          const roleMatch = condition.match(/chat\.role\s*===?\s*['"]([^'"]+)['"]/);
          if (roleMatch) {
            return {
              name: 'filter',
              type: 'Combined Filter',
              description: `${baseDesc} from ${roleMatch[1]}`
            };
          }
        }
        // Single condition or other combinations - still return type filter
        return {
          name: 'filter',
          type: conditionCount > 1 ? 'Combined Filter' : 'Type Filter',
          description: baseDesc
        };
      }
    }

    if (hasTrust) {
      return {
        name: 'filter',
        type: 'Security Filter',
        description: 'Trusted content only'
      };
    }

    if (hasChatRole) {
      const roleMatch = condition.match(/chat\.role\s*===?\s*['"]([^'"]+)['"]/);
      if (roleMatch) {
        return {
          name: 'filter',
          type: 'Role Filter',
          description: `Only ${roleMatch[1]} messages`
        };
      }
    }

    // Generic filter
    return {
      name: 'filter',
      type: 'Condition Filter',
      description: condition.length > 40 ? condition.slice(0, 40) + '...' : condition
    };
  }

  return {
    name: 'filter',
    type: 'RxJS Operator',
    description: 'Filters based on condition'
  };
}

/**
 * Parse map operator to extract transformation
 */
export function parseMap(args: string): ParsedOperator {
  const cleanArgs = args.replace(/\s+/g, ' ').trim();

  // Extract transformation from arrow function
  const arrowMatch = cleanArgs.match(/\([^)]*\)\s*=>\s*(.+)/);
  if (arrowMatch) {
    const transform = arrowMatch[1].trim();

    // Parse common map patterns
    if (transform.includes('annotateChunk')) {
      const annotMatch = transform.match(/annotateChunk\([^,]+,\s*['"]([^'"]+)['"]/);
      if (annotMatch) {
        return {
          name: 'map',
          type: 'Annotation',
          description: `Sets ${annotMatch[1]}`
        };
      }
    }

    if (transform.includes('return')) {
      const returnVal = transform.match(/return\s+(.+?);?$/);
      if (returnVal) {
        return {
          name: 'map',
          type: 'Transform',
          description: returnVal[1].length > 40 ? returnVal[1].slice(0, 40) + '...' : returnVal[1]
        };
      }
    }

    return {
      name: 'map',
      type: 'Transform',
      description: transform.length > 40 ? transform.slice(0, 40) + '...' : transform
    };
  }

  return {
    name: 'map',
    type: 'RxJS Operator',
    description: 'Transforms values'
  };
}

/**
 * Parse mergeMap/switchMap operators
 */
export function parseMapOperator(funcName: string, args: string): ParsedOperator {
  const cleanArgs = args.replace(/\s+/g, ' ').trim();

  // Check for completeTurnWithLLM
  if (cleanArgs.includes('completeTurnWithLLM')) {
    return {
      name: funcName,
      type: 'LLM Call',
      description: 'Generates LLM response'
    };
  }

  // Check for evaluator calls
  const evaluatorMatch = cleanArgs.match(/(create\w+Evaluator|processWithEvaluator|\w+Evaluator)/);
  if (evaluatorMatch) {
    return {
      name: funcName,
      type: 'Async Processing',
      description: getEvaluatorDescription(evaluatorMatch[1])
    };
  }

  // Check for direct evaluator function calls (detectToolCalls, executeTools, etc.)
  // Match both empty args func() and with args func({ ... })
  const directEvaluatorMatch = cleanArgs.match(/^(\w+)\s*\(/);
  if (directEvaluatorMatch) {
    const calledFunc = directEvaluatorMatch[1];
    const description = getEvaluatorDescription(calledFunc);
    if (description !== calledFunc) {
      return {
        name: calledFunc,
        type: 'Custom Evaluator',
        description
      };
    }
  }

  // Check for session calls
  if (cleanArgs.includes('session.')) {
    const sessionMatch = cleanArgs.match(/session\.(\w+)/);
    if (sessionMatch) {
      return {
        name: funcName,
        type: 'Session Operation',
        description: `Uses ${sessionMatch[1]}`
      };
    }
  }

  return {
    name: funcName,
    type: 'Async Transform',
    description: 'Maps to async operation'
  };
}

/**
 * Parse tap operator (side effects)
 */
export function parseTap(args: string): ParsedOperator {
  const cleanArgs = args.replace(/\s+/g, ' ').trim();

  if (cleanArgs.includes('outputStream')) {
    return {
      name: 'tap',
      type: 'Side Effect',
      description: 'Outputs to stream'
    };
  }

  if (cleanArgs.includes('errorStream')) {
    return {
      name: 'tap',
      type: 'Error Handling',
      description: 'Logs errors'
    };
  }

  return {
    name: 'tap',
    type: 'Side Effect',
    description: 'Performs side effect'
  };
}

/**
 * Get description for evaluator functions
 */
export function getEvaluatorDescription(name: string): string {
  const descriptions: Record<string, string> = {
    parseMarkdownForVoice: 'Parses markdown for voice output',
    generateVoice: 'Generates voice audio',
    analyzeSentiment: 'Analyzes sentiment',
    detectToolCalls: 'Detects tool calls',
    detectTools: 'Detects tool calls',
    executeTools: 'Executes tools',
    createEvaluator: 'Creates LLM evaluator',
    createLLMChunkEvaluator: 'LLM completion',
    completeTurnWithLLM: 'LLM response generation',
    processWithEvaluator: 'Processes with evaluator'
  };

  // Check for exact match first
  if (descriptions[name]) {
    return descriptions[name];
  }

  // Check for partial matches
  for (const [key, desc] of Object.entries(descriptions)) {
    if (name.toLowerCase().includes(key.toLowerCase())) {
      return desc;
    }
  }

  return name;
}

/**
 * Get descriptions for common RxJS operators
 */
export function getOperatorDescription(op: string): string {
  const descriptions: Record<string, string> = {
    filter: 'Filters chunks based on condition',
    map: 'Transforms chunks',
    mergeMap: 'Maps to observables, then flattens',
    catchError: 'Handles errors',
    debounceTime: 'Debounces chunks',
    distinctUntilChanged: 'Filters duplicates',
    tap: 'Performs side effects',
    switchMap: 'Maps to observable, switching to new'
  };

  return descriptions[op] || 'RxJS Operator';
}
