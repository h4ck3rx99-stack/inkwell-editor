import { handleStatus } from '@/server/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return handleStatus();
}
