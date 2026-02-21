/**
 * RXCAFE Scheduler
 * Simple cron-based scheduling for background agents
 */

interface ScheduledJob {
  id: string;
  cronExpr: string;
  callback: () => void | Promise<void>;
  intervalId: Timer | null;
  nextRun: number | null;
}

const scheduledJobs = new Map<string, ScheduledJob>();

function parseCronExpression(expr: string): { minute: number[]; hour: number[]; dayOfMonth: number[]; month: number[]; dayOfWeek: number[] } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expr}. Expected 5 parts (minute hour dayOfMonth month dayOfWeek)`);
  }
  
  const parsePart = (part: string, min: number, max: number): number[] => {
    if (part === '*') {
      return [];
    }
    
    const values: number[] = [];
    const ranges = part.split(',');
    
    for (const range of ranges) {
      if (range.includes('/')) {
        const [base, stepStr] = range.split('/');
        const step = parseInt(stepStr, 10);
        
        if (base === '*') {
          for (let i = min; i <= max; i += step) {
            values.push(i);
          }
        } else {
          const [start, end] = base.split('-').map(n => parseInt(n, 10));
          for (let i = start; i <= (end || start); i += step) {
            if (i >= min && i <= max) values.push(i);
          }
        }
      } else if (range.includes('-')) {
        const [start, end] = range.split('-').map(n => parseInt(n, 10));
        for (let i = start; i <= end; i++) {
          if (i >= min && i <= max) values.push(i);
        }
      } else {
        const val = parseInt(range, 10);
        if (val >= min && val <= max) values.push(val);
      }
    }
    
    return [...new Set(values)].sort((a, b) => a - b);
  };
  
  return {
    minute: parsePart(parts[0], 0, 59),
    hour: parsePart(parts[1], 0, 23),
    dayOfMonth: parsePart(parts[2], 1, 31),
    month: parsePart(parts[3], 1, 12),
    dayOfWeek: parsePart(parts[4], 0, 6),
  };
}

function getNextRun(parsed: ReturnType<typeof parseCronExpression>, from: Date = new Date()): Date {
  const now = new Date(from);
  now.setSeconds(0);
  now.setMilliseconds(0);
  
  for (let i = 0; i < 366 * 24 * 60; i++) {
    now.setMinutes(now.getMinutes() + 1);
    
    if (parsed.minute.length && !parsed.minute.includes(now.getMinutes())) continue;
    if (parsed.hour.length && !parsed.hour.includes(now.getHours())) continue;
    if (parsed.dayOfMonth.length && !parsed.dayOfMonth.includes(now.getDate())) continue;
    if (parsed.month.length && !parsed.month.includes(now.getMonth() + 1)) continue;
    if (parsed.dayOfWeek.length && !parsed.dayOfWeek.includes(now.getDay())) continue;
    
    return now;
  }
  
  throw new Error('Could not find next run time within a year');
}

function checkAndRun(job: ScheduledJob): void {
  const now = new Date();
  const parsed = parseCronExpression(job.cronExpr);
  
  const matches = () => {
    if (parsed.minute.length && !parsed.minute.includes(now.getMinutes())) return false;
    if (parsed.hour.length && !parsed.hour.includes(now.getHours())) return false;
    if (parsed.dayOfMonth.length && !parsed.dayOfMonth.includes(now.getDate())) return false;
    if (parsed.month.length && !parsed.month.includes(now.getMonth() + 1)) return false;
    if (parsed.dayOfWeek.length && !parsed.dayOfWeek.includes(now.getDay())) return false;
    return true;
  };
  
  if (matches()) {
    try {
      Promise.resolve(job.callback()).catch(err => {
        console.error(`[Scheduler] Job ${job.id} error:`, err);
      });
    } catch (err) {
      console.error(`[Scheduler] Job ${job.id} error:`, err);
    }
  }
  
  job.nextRun = getNextRun(parsed, now).getTime();
}

export function schedule(cronExpr: string, callback: () => void | Promise<void>): () => void {
  const id = `job-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  const job: ScheduledJob = {
    id,
    cronExpr,
    callback,
    intervalId: null,
    nextRun: null,
  };
  
  const parsed = parseCronExpression(cronExpr);
  job.nextRun = getNextRun(parsed).getTime();
  
  job.intervalId = setInterval(() => checkAndRun(job), 60000);
  
  scheduledJobs.set(id, job);
  
  console.log(`[Scheduler] Scheduled job ${id}: ${cronExpr}, next run: ${new Date(job.nextRun!).toISOString()}`);
  
  return () => {
    if (job.intervalId) {
      clearInterval(job.intervalId);
    }
    scheduledJobs.delete(id);
    console.log(`[Scheduler] Cancelled job ${id}`);
  };
}

export function getScheduledJobs(): Array<{ id: string; cronExpr: string; nextRun: number | null }> {
  return Array.from(scheduledJobs.values()).map(job => ({
    id: job.id,
    cronExpr: job.cronExpr,
    nextRun: job.nextRun,
  }));
}

export function clearAllScheduledJobs(): void {
  for (const job of scheduledJobs.values()) {
    if (job.intervalId) {
      clearInterval(job.intervalId);
    }
  }
  scheduledJobs.clear();
  console.log('[Scheduler] Cleared all scheduled jobs');
}
