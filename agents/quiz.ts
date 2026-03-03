/**
 * Quiz Agent
 * A quiz game agent that demonstrates quick responses functionality.
 * Users answer multiple choice questions with quick response buttons.
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk, createTextChunk } from '../lib/chunk.js';
import { EMPTY, filter, mergeMap, catchError, of } from '../lib/stream.js';

interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

const DEFAULT_QUIZ: QuizQuestion[] = [
  {
    question: "What is the capital of France?",
    options: ["London", "Paris", "Berlin", "Madrid"],
    correctIndex: 1,
    explanation: "Paris is the capital and most populous city of France."
  },
  {
    question: "Which planet is known as the Red Planet?",
    options: ["Venus", "Mars", "Jupiter", "Saturn"],
    correctIndex: 1,
    explanation: "Mars appears red due to iron oxide (rust) on its surface."
  },
  {
    question: "What is 7 × 8?",
    options: ["54", "56", "58", "64"],
    correctIndex: 1,
    explanation: "7 × 8 = 56"
  },
  {
    question: "Who wrote 'Romeo and Juliet'?",
    options: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"],
    correctIndex: 1,
    explanation: "William Shakespeare wrote Romeo and Juliet around 1594-1596."
  },
  {
    question: "What is the largest ocean on Earth?",
    options: ["Atlantic", "Indian", "Pacific", "Arctic"],
    correctIndex: 2,
    explanation: "The Pacific Ocean covers about 63 million square miles."
  }
];

interface QuizState {
  questions: QuizQuestion[];
  currentQuestion: number;
  score: number;
  totalAnswered: number;
  inQuiz: boolean;
}

const QUIZ_SYSTEM_PROMPT = `You are a fun quiz game host. Your job is to:
1. Present questions to the user one at a time
2. Wait for their answer
3. Tell them if they're correct and explain why
4. Move to the next question

When you ask a question, include the answer options as quick responses using the 'com.rxcafe.quickResponses' annotation with an array of the option strings.

Keep your responses brief and friendly. Have fun!`;

export const quizAgent: AgentDefinition = {
  name: 'quiz',
  description: 'A fun quiz game with multiple choice questions',
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      questionCount: { type: 'number', description: 'Number of questions per quiz', default: 5 }
    },
    required: ['backend', 'model']
  },

  initialize(session: AgentSessionContext) {
    const state: QuizState = {
      questions: [...DEFAULT_QUIZ],
      currentQuestion: 0,
      score: 0,
      totalAnswered: 0,
      inQuiz: false
    };

    if (!session.systemPrompt) {
      session.systemPrompt = QUIZ_SYSTEM_PROMPT;
    } else {
      session.systemPrompt += '\n\n' + QUIZ_SYSTEM_PROMPT;
    }

    const startQuiz = async (sessionCtx: AgentSessionContext) => {
      state.inQuiz = true;
      state.currentQuestion = 0;
      state.score = 0;
      state.totalAnswered = 0;

      const question = state.questions[0];
      const questionChunk = createTextChunk(
        `🎯 *Quiz Time!*\n\n${question.question}`,
        'com.rxcafe.quiz',
        {
          'chat.role': 'assistant',
          'com.rxcafe.quickResponses': question.options
        }
      );
      sessionCtx.outputStream.next(questionChunk);
    };

    session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      filter((chunk: Chunk) => chunk.annotations['chat.role'] === 'user'),

      mergeMap(async (chunk: Chunk) => {
        const content = chunk.content?.toString().toLowerCase().trim() || '';

        if (content === 'start quiz' || content === 'quiz' || content === 'start') {
          await startQuiz(session);
          if (session.callbacks?.onFinish) session.callbacks.onFinish();
          return null;
        }

        if (content === 'score' || content === 'stats') {
          const scoreMsg = `📊 *Your Score*\n\nScore: ${state.score}/${state.totalAnswered}\n${state.totalAnswered > 0 ? `Percentage: ${Math.round((state.score / state.totalAnswered) * 100)}%` : 'No questions answered yet'}`;
          const scoreChunk = createTextChunk(scoreMsg, 'com.rxcafe.quiz', {
            'chat.role': 'assistant'
          });
          session.outputStream.next(scoreChunk);
          if (session.callbacks?.onFinish) session.callbacks.onFinish();
          return null;
        }

        if (content === 'help' || content === 'commands') {
          const helpMsg = `📚 *Quiz Commands:*\n\n• start quiz - Start a new quiz\n• score - View your current score\n• help - Show this help message`;
          const helpChunk = createTextChunk(helpMsg, 'com.rxcafe.quiz', {
            'chat.role': 'assistant'
          });
          session.outputStream.next(helpChunk);
          if (session.callbacks?.onFinish) session.callbacks.onFinish();
          return null;
        }

        if (!state.inQuiz) {
          const welcomeChunk = createTextChunk(
            `🎉 *Welcome to the Quiz Game!*\n\nI'll ask you some fun questions and you can pick from the answer options.\n\nType *start quiz* to begin!`,
            'com.rxcafe.quiz',
            {
              'chat.role': 'assistant',
              'com.rxcafe.quickResponses': ['Start Quiz', 'Help']
            }
          );
          session.outputStream.next(welcomeChunk);
          if (session.callbacks?.onFinish) session.callbacks.onFinish();
          return null;
        }

        const currentQ = state.questions[state.currentQuestion];
        const userAnswer = content;
        const isCorrect = currentQ.options.some((opt, idx) => 
          opt.toLowerCase() === userAnswer || idx.toString() === userAnswer || 
          userAnswer === ['a', 'b', 'c', 'd'][idx]
        );

        state.totalAnswered++;
        if (isCorrect) {
          state.score++;
        }

        const feedback = isCorrect 
          ? `✅ *Correct!*\n\n${currentQ.explanation}`
          : `❌ *Wrong!*\n\nThe correct answer was: *${currentQ.options[currentQ.correctIndex]}*\n\n${currentQ.explanation}`;

        state.currentQuestion++;

        if (state.currentQuestion >= state.questions.length) {
          const finalScore = state.score;
          const total = state.totalAnswered;
          const percentage = Math.round((finalScore / total) * 100);
          
          let emoji = '😐';
          if (percentage >= 80) emoji = '🏆';
          else if (percentage >= 60) emoji = '😊';
          else if (percentage >= 40) emoji = '😐';
          else emoji = '😢';

          const resultMsg = `${feedback}\n\n🎉 *Quiz Complete!*\n\n${emoji} Final Score: ${finalScore}/${total} (${percentage}%)\n\nType *start quiz* to play again!`;
          
          const resultChunk = createTextChunk(resultMsg, 'com.rxcafe.quiz', {
            'chat.role': 'assistant',
            'com.rxcafe.quickResponses': ['Start Quiz', 'Score']
          });
          session.outputStream.next(resultChunk);
          state.inQuiz = false;
        } else {
          const nextQ = state.questions[state.currentQuestion];
          const nextMsg = `${feedback}\n\n📝 *Next Question:*\n\n${nextQ.question}`;
          
          const nextChunk = createTextChunk(nextMsg, 'com.rxcafe.quiz', {
            'chat.role': 'assistant',
            'com.rxcafe.quickResponses': nextQ.options
          });
          session.outputStream.next(nextChunk);
        }

        if (session.callbacks?.onFinish) session.callbacks.onFinish();
        return null;
      }),

      filter((chunk: Chunk | null): chunk is Chunk => chunk !== null),

      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => session.outputStream.next(chunk),
      error: (error: Error) => session.errorStream.next(error)
    });

    const welcomeChunk = createTextChunk(
      `🎉 *Welcome to the Quiz Game!*\n\nI'll ask you some fun questions and you can pick from the answer options.\n\nType *start quiz* to begin!`,
      'com.rxcafe.quiz',
      {
        'chat.role': 'assistant',
        'com.rxcafe.quickResponses': ['Start Quiz', 'Help']
      }
    );
    session.outputStream.next(welcomeChunk);
  }
};

export default quizAgent;
