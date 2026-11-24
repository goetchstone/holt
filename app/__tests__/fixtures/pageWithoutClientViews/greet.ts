// /app/__tests__/fixtures/pageWithoutClientViews/greet.ts
//
// A server module the fixture page runs for real. It names "use client" only
// in this comment, which does not make it a client module.

export function greet(name: string): string {
  return `Hello, ${name}`;
}
