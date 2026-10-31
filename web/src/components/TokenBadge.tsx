import type { Token } from "@/lib/tokens";

export function TokenBadge({ token, size = 32 }: { token: Token; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-black"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.32,
        background: `linear-gradient(135deg, ${token.color}, ${token.color}99)`,
      }}
    >
      {token.symbol.slice(0, 3)}
    </span>
  );
}
