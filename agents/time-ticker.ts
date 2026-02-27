import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk } from '../lib/chunk.js';

export const timeTickerAgent: AgentDefinition = {
  name: 'time-ticker',
  description: 'Background agent that outputs the current time every 2 seconds',
  startInBackground: true,
  persistsState: false,
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  initialize(session: AgentSessionContext) {
    console.log(`[TimeTicker] Initializing time-ticker agent for session ${session.id}`);
    
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
        console.log(`[TimeTicker] Stopping time-ticker for session ${session.id}`);
      }
    } as any;
  },
  
  destroy(session: AgentSessionContext) {
    console.log(`[TimeTicker] Destroying time-ticker agent for session ${session.id}`);
    if (session.pipelineSubscription) {
      session.pipelineSubscription.unsubscribe();
    }
  }
};

export default timeTickerAgent;
