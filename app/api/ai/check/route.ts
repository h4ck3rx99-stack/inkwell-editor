import { handleCheck } from '@/server/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(req: Request) {
  return handleCheck(req);
}
