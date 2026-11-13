// Mocked WMS, TMS and carrier data for the POC. Typed adapters in tools.ts read only from here,
// so swapping in real systems later changes this layer and nothing above it.
import type { Carrier, Email, Load, Order, Slot } from '../domain/types';

export const SLOTS: Slot[] = [
  { dock: 'Dock 3', window: 'Mon 16 Nov, 16:00–17:00', day: 16, hour: 16 },
  { dock: 'Dock 4', window: 'Tue 17 Nov, 05:00–06:00', day: 17, hour: 5 },
  { dock: 'Dock 2', window: 'Wed 18 Nov, 06:00–07:00', day: 18, hour: 6 },
  { dock: 'Dock 5', window: 'Wed 18 Nov, 15:00–16:00', day: 18, hour: 15 },
  { dock: 'Dock 1', window: 'Thu 19 Nov, 14:00–15:00', day: 19, hour: 14 },
  { dock: 'Dock 6', window: 'Fri 20 Nov, 04:00–05:00', day: 20, hour: 4 }
];

// Hire-or-reward haulage in Malaysia needs a valid APAD Class A carrier permit (Land Public Transport Act 2010).
export const CARRIERS: Carrier[] = [
  { name: 'Utara Haulage', ratePerKm: 6.1, onTimePct: 96, equipment: ['Curtain-sider', 'Tail-lift'], permit: 'Valid to 30 Jun 2027', permitValid: true },
  { name: 'Semenanjung Freight', ratePerKm: 5.8, onTimePct: 91, equipment: ['Curtain-sider', 'Tail-lift'], permit: 'Expired 31 Oct 2026', permitValid: false },
  { name: 'Lebuhraya Express', ratePerKm: 6.6, onTimePct: 98, equipment: ['Curtain-sider', 'Tail-lift', 'Air-ride'], permit: 'Valid to 14 Feb 2028', permitValid: true },
  { name: 'SejukLine Reefer', ratePerKm: 6.4, onTimePct: 95, equipment: ['Reefer'], permit: 'Valid to 31 Dec 2027', permitValid: true },
  { name: 'Pantai Timur Cold Chain', ratePerKm: 6.0, onTimePct: 92, equipment: ['Reefer', 'Tail-lift'], permit: 'Valid to 30 Sep 2027', permitValid: true }
];

export const SEED_LOADS: Load[] = [
  { id: 'LD-2285', dest: 'Melaka', pallets: 9, temp: 'chilled', pickup: 'Fri 13 Nov, 05:00–06:00 · Dock 6', carrier: 'SejukLine Reefer', rateRm: 1160, status: 'Booked' },
  { id: 'LD-2288', dest: 'Ipoh', pallets: 18, temp: 'ambient', pickup: 'Fri 13 Nov, 07:00–08:00 · Dock 3', carrier: 'Utara Haulage', rateRm: 1220, status: 'Booked' },
  { id: 'LD-2290', dest: 'Johor Bahru', pallets: 20, temp: 'ambient', pickup: '', carrier: '', rateRm: null, status: 'Planned' },
  { id: 'LD-2291', dest: 'Penang', pallets: 10, temp: 'ambient', pickup: '', carrier: '', rateRm: null, status: 'Planned' }
];

/** Requests already in the inbox when the demo opens. `read` is what intake extracted on arrival. */
export const SEED_EMAILS: (Email & { read: Partial<Order> })[] = [
  {
    id: 'e1', from: 'Aina Rahman', company: 'Kedai Harian Sdn Bhd', subject: 'Penang store hub replenishment', receivedAt: '08:12',
    body: 'Hi team,\n\nWe need 14 pallets of ambient FMCG moved from your Shah Alam DC to our Penang store hub. Delivery by Thursday 19 Nov before noon. Our budget is around RM 2,400 and the truck needs a tail-lift.\n\nThanks,\nAina',
    read: { customer: 'Kedai Harian Sdn Bhd', contact: 'Aina Rahman', destination: 'Penang', pallets: 14, commodity: 'Ambient FMCG', temp: 'ambient', equipment: ['Tail-lift'], deliverBy: 'Thu 19 Nov, before 12:00', budgetRm: 2400, missing: [] }
  },
  {
    id: 'e2', from: 'Marcus Lim', company: 'Lumen Electronics', subject: 'Urgent: service parts to JB', receivedAt: '08:47',
    body: 'Morning,\n\n6 pallets of boxed electronics, fragile, from Shah Alam to our Johor Bahru service centre. They must arrive on Tuesday 17 Nov. Please confirm the cost before you book.\n\nMarcus',
    read: { customer: 'Lumen Electronics', contact: 'Marcus Lim', destination: 'Johor Bahru', pallets: 6, commodity: 'Boxed electronics, fragile', temp: 'ambient', equipment: [], deliverBy: 'Tue 17 Nov', budgetRm: null, missing: [] }
  },
  {
    id: 'e3', from: 'Siti Noor', company: 'Ladang Segar Dairy', subject: 'Chilled dairy to Kuantan', receivedAt: '09:20',
    body: 'Hello,\n\nCan you move 22 pallets of chilled dairy to our Kuantan distributor for Friday 20 Nov morning? Product must stay at 2–6°C. I am not sure of the total weight yet.\n\nRegards,\nSiti',
    read: { customer: 'Ladang Segar Dairy', contact: 'Siti Noor', destination: 'Kuantan', pallets: 22, commodity: 'Chilled dairy', temp: 'chilled', equipment: ['Reefer 2–6°C'], deliverBy: 'Fri 20 Nov, morning', budgetRm: null, missing: ['Total weight'] }
  }
];

export const EXAMPLES = [
  { label: 'Chilled produce to Ipoh', text: 'Hi team,\n\nWe need 8 pallets of chilled produce sent to Ipoh by Wednesday 18 Nov, before 10am. Keep it at 2–8°C. Budget is about RM 1,500.\n\nThanks,\nNur Hidayah\nSegar Mart' },
  { label: 'Frozen seafood to Kuala Terengganu', text: 'Hello,\n\nPlease move 12 pallets of frozen seafood to our Kuala Terengganu cold store. It has to arrive by Friday 20 Nov and stay at -18°C.\n\nDaniel Tan\nLautan Foods' },
  { label: 'A vague request', text: 'Hi, can you send some of our stock up north next week? Let me know the price.\n\nRaj' }
];
