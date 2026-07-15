import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Conditional className joiner.
 *
 * twMerge resolves conflicting Tailwind utilities last-wins, which is what makes a
 * caller's `className` able to override a component's own defaults. Without it,
 * `<Button className="bg-red-500">` emits both background classes and the winner is
 * decided by CSS source order rather than by the caller.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
