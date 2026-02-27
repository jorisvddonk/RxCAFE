import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk, createBinaryChunk } from '../lib/chunk.js';
import { filter } from '../lib/stream.js';

/**
 * Image Painter Agent
 * Responds to messages by generating a random pixel art image (BMP)
 */
export const imagePainterAgent: AgentDefinition = {
  name: 'image-painter',
  description: 'Generates random pixel images in response to messages',
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  initialize(session: AgentSessionContext) {
    console.log(`[ImagePainter] Initializing for session ${session.id}`);
    
    const sub = session.inputStream.pipe(
      filter(c => c.contentType === 'text' && c.annotations['chat.role'] === 'user')
    ).subscribe(async chunk => {
      const text = (chunk.content as string).toLowerCase();
      
      // Simulate token streaming for the text response
      const responseText = `I'll paint something for you! Generating a random 64x64 image...`;
      if (session.callbacks?.onToken) {
        for (const word of responseText.split(' ')) {
          session.callbacks.onToken(word + ' ');
          await new Promise(r => setTimeout(r, 50)); // Slow down for effect
        }
      }

      // Send the full text chunk to history/SSE
      session.outputStream.next(createTextChunk(
        responseText,
        'com.rxcafe.image-painter',
        { 'chat.role': 'assistant' }
      ));
      
      // Generate a random BMP image
      const width = 64;
      const height = 64;
      const bmpData = createRandomBmp(width, height);
      
      // Send the image as a binary chunk
      const imageChunk = createBinaryChunk(
        bmpData,
        'image/bmp',
        'com.rxcafe.image-painter',
        { 
          'chat.role': 'assistant',
          'image.width': width,
          'image.height': height,
          'image.description': 'Random noise pattern'
        }
      );
      
      session.outputStream.next(imageChunk);
      
      // Notify the frontend that generation is complete
      if (session.callbacks?.onFinish) {
        session.callbacks.onFinish();
      }
    });
    
    session.pipelineSubscription = sub;
  }
};

/**
 * Creates a minimal 24-bit BMP file buffer with random noise
 */
function createRandomBmp(width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buffer = new Uint8Array(fileSize);
  const view = new DataView(buffer.buffer);
  
  // File Header
  buffer[0] = 0x42; buffer[1] = 0x4D; // "BM"
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true); // Offset to pixel data
  
  // DIB Header
  view.setUint32(14, 40, true); // Header size
  view.setUint32(18, width, true);
  view.setInt32(22, height, true); // Positive means bottom-to-top
  view.setUint16(26, 1, true); // Planes
  view.setUint16(28, 24, true); // Bits per pixel
  view.setUint32(34, pixelDataSize, true);
  
  // Pixel data
  let pos = 54;
  const r = Math.random() * 255;
  const g = Math.random() * 255;
  const b = Math.random() * 255;

  for (let y = 0; y < height; y++) {
    const rowStart = pos;
    for (let x = 0; x < width; x++) {
      // Random colorful pattern or noise
      buffer[pos++] = (Math.random() * 255 + b) % 256; // Blue
      buffer[pos++] = (Math.random() * 255 + g) % 256; // Green
      buffer[pos++] = (Math.random() * 255 + r) % 256; // Red
    }
    // Padding to 4-byte boundary
    while (pos < rowStart + rowSize) {
      buffer[pos++] = 0;
    }
  }
  
  return buffer;
}

export default imagePainterAgent;
