import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk } from '../lib/chunk.js';

export const timeTickerAgent: AgentDefinition = {
  name: 'time-ticker',
  description: 'Background agent that outputs the current time every 2 seconds',
  startInBackground: true,
  
  initialize(session: AgentSessionContext) {
    const emitTime = () => {
      const now = new Date();
      const timeStr = now.toLocaleTimeString();
      const chunk = createTextChunk(
        `Current time: ${timeStr}`,
        'com.rxcafe.time-ticker',
        { 'chat.role': 'assistant', 'time-ticker': true }
      );
      session.outputStream.next(chunk);
    };
    
    emitTime();
    
    const intervalId = setInterval(emitTime, 2000);
    
    session.pipelineSubscription = {
      unsubscribe: () => {
        clearInterval(intervalId);
      }
    } as any;
  },
  
  destroy(session: AgentSessionContext) {
    if (session.pipelineSubscription) {
      session.pipelineSubscription.unsubscribe();
    }
  }
};

export default timeTickerAgent;
