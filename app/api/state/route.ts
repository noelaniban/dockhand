import { NextResponse } from 'next/server';
import { snapshot } from '@/lib/orchestrator/snapshot';

export const dynamic = 'force-dynamic';
export const GET = () => NextResponse.json(snapshot());
