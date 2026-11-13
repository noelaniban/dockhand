// End-to-end runs of the request state machine with the scripted agents (DOCKHAND_SCRIPTED=1).
import { beforeEach, describe, expect, it } from 'vitest';
import { approve, askCustomer, receive, requestState, setAutonomy } from '@/lib/orchestrator/machine';
import { db, resetStore } from '@/lib/orchestrator/store';
import { EXAMPLES } from '@/lib/tools/data';

const run = (id: string) => db().runs[id];
const load = (id: string) => db().loads.find(l => l.id === id);

beforeEach(() => resetStore());

describe('approve mode', () => {
  it('books Kedai Harian into the open Penang load after three approvals', async () => {
    expect(requestState(run('e1'))).toBe('Needs you');

    await approve('e1'); // order
    expect(run('e1').dispatch?.status).toBe('review');
    expect(run('e1').dispatch?.data).toMatchObject({ consolidate: true, loadId: 'LD-2291', total: 24, dock: 'Dock 5' });

    await approve('e1'); // plan
    const deal = run('e1').carrier!.data!;
    expect(deal.pick).toBe('Utara Haulage');
    expect(deal.excluded[0]).toMatch(/Semenanjung Freight/);
    expect(deal.finalRm).toBeLessThanOrEqual(deal.quoteRm);
    expect(deal.withinBenchmark).toBe(true);
    expect(load('LD-2291')?.status).toBe('Planned'); // nothing books before the rate is approved

    await approve('e1'); // rate
    expect(requestState(run('e1'))).toBe('Booked');
    expect(load('LD-2291')).toMatchObject({ status: 'Booked', pallets: 24, carrier: 'Utara Haulage', rateRm: deal.finalRm });
    expect(run('e1').booking?.data?.confirmation).toMatch(/LD-2291/);
    expect(['intake', 'dispatch', 'carrier'].every(k => run('e1')[k as 'intake']?.by === 'you')).toBe(true);
  });

  it('refuses to approve twice or with nothing waiting', async () => {
    await approve('e1');
    await approve('e1');
    await approve('e1');
    await expect(approve('e1')).rejects.toThrow(/Nothing is waiting/);
  });

  it('opens a new load when no open load fits', async () => {
    await approve('e3');
    expect(run('e3').dispatch?.data).toMatchObject({ consolidate: false, loadId: 'LD-2296', total: 22, truck: 'Reefer trailer' });
  });

  it('never consolidates two orders into the same load', async () => {
    await approve('e2'); // reserves LD-2290 for Lumen
    const id = await receive('Hi,\n\nPlease send 4 pallets to Johor Bahru by Tuesday 17 Nov.\n\nAmir\nTeknik Jaya');
    await approve(id);
    expect(run('e2').dispatch?.data?.loadId).toBe('LD-2290');
    expect(run(id).dispatch?.data?.loadId).not.toBe('LD-2290');
  });
});

describe('a vague request', () => {
  it('is held, cannot be approved, and gets a clarification instead', async () => {
    const id = await receive(EXAMPLES[2].text);
    const o = run(id).intake!.data!;
    expect(o.missing).toEqual(['Pallet count', 'Delivery city', 'Delivery date']);
    expect(requestState(run(id))).toBe('Needs you');

    await expect(approve(id)).rejects.toThrow(/Ask the customer/);
    expect(run(id).intake?.status).toBe('review');

    askCustomer(id);
    expect(requestState(run(id))).toBe('Waiting on the customer');
    expect(run(id).reply).toMatch(/pallet count, delivery city and delivery date/);
    expect(run(id).dispatch).toBeUndefined();
  });

  it('is still held in auto mode', async () => {
    setAutonomy('auto');
    const id = await receive(EXAMPLES[2].text);
    expect(requestState(run(id))).toBe('Needs you');
    expect(run(id).dispatch).toBeUndefined();
  });
});

describe('auto mode', () => {
  it('runs a complete request to booked with no human step', async () => {
    setAutonomy('auto');
    const id = await receive(EXAMPLES[0].text);
    const r = run(id);
    expect(r.intake?.data).toMatchObject({ pallets: 8, destination: 'Ipoh', temp: 'chilled', contact: 'Nur Hidayah', customer: 'Segar Mart' });
    expect(requestState(r)).toBe('Booked');
    expect(['intake', 'dispatch', 'carrier'].every(k => r[k as 'intake']?.by === 'agent')).toBe(true);
    expect(load(r.dispatch!.data!.loadId)?.status).toBe('Booked');
    expect(db().bookedIn[id]).toBeGreaterThanOrEqual(0);
  });

  it('holds a booking above the lane benchmark for a person', async () => {
    setAutonomy('auto');
    // Frozen seafood to Kuala Terengganu: only reefers, longest lane. Make the carrier stubborn by
    // raising every reefer rate so the negotiated price lands above the benchmark.
    const { CARRIERS } = await import('@/lib/tools/data');
    const saved = CARRIERS.map(c => c.ratePerKm);
    CARRIERS.forEach(c => { if (c.equipment.includes('Reefer')) c.ratePerKm = 9; });
    try {
      const id = await receive(EXAMPLES[1].text);
      const r = run(id);
      expect(r.dispatch?.by).toBe('agent');
      expect(r.carrier?.status).toBe('review');
      expect(r.carrier?.data?.withinBenchmark).toBe(false);
      expect(r.booking).toBeUndefined();
      expect(requestState(r)).toBe('Needs you');
    } finally {
      CARRIERS.forEach((c, i) => { c.ratePerKm = saved[i]; });
    }
  });
});

describe('audit', () => {
  it('records every tool call on the step that made it', async () => {
    await approve('e1');
    await approve('e1');
    const tools = (k: 'dispatch' | 'carrier') => run('e1')[k]!.calls.map(c => c.tool);
    expect(tools('dispatch')).toEqual(['tms_open_loads', 'wms_dock_slots']);
    expect(tools('carrier')).toEqual(['carriers_eligible', 'carriers_request_quotes', 'tms_lane_benchmark', 'carriers_send_counter']);
    expect(db().log[0]).toMatchObject({ actor: 'Carrier' });
  });
});
