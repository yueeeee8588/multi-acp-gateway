// Kuro-chan: an ink-black cat mascot illustration. Purely decorative;
// colours are inline so the drawing stays intact even before styles load.
export function Mascot({ size = 56 }: { size?: number }) {
  return (
    <svg
      className="mascot"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      {/* Sparkles */}
      <path
        d="M9 13 L10.2 16.2 L13.4 17.4 L10.2 18.6 L9 21.8 L7.8 18.6 L4.6 17.4 L7.8 16.2 Z"
        fill="#f59e0b"
        opacity="0.9"
      />
      <path
        d="M54 13 L54.8 15.2 L57 16 L54.8 16.8 L54 19 L53.2 16.8 L51 16 L53.2 15.2 Z"
        fill="#fb7185"
        opacity="0.85"
      />
      <circle cx="49" cy="9" r="1.4" fill="#fde68a" />

      {/* Tail */}
      <path
        d="M47 48 C55 50 61 44 59 34 C57 26 51 27 50 31 C49 35 53 37 47 43 Z"
        fill="#232430"
        stroke="#161720"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Body & Paws */}
      <ellipse cx="32" cy="46" rx="16" ry="12.5" fill="#232430" stroke="#161720" strokeWidth="2" />
      <ellipse cx="27" cy="55.5" rx="4.5" ry="3" fill="#2d2e3d" stroke="#161720" strokeWidth="1.6" />
      <ellipse cx="37" cy="55.5" rx="4.5" ry="3" fill="#2d2e3d" stroke="#161720" strokeWidth="1.6" />

      {/* Ears */}
      <polygon points="17,25 18,9 29,18" fill="#232430" stroke="#161720" strokeWidth="2" strokeLinejoin="round" />
      <polygon points="19.5,22 20.5,13 27,19" fill="#fca5a5" opacity="0.8" />
      <polygon points="47,25 46,9 35,18" fill="#232430" stroke="#161720" strokeWidth="2" strokeLinejoin="round" />
      <polygon points="44.5,22 43.5,13 37,19" fill="#fca5a5" opacity="0.8" />

      {/* Head */}
      <ellipse cx="32" cy="27" rx="16.5" ry="13.5" fill="#232430" stroke="#161720" strokeWidth="2" />

      {/* Cheeks */}
      <ellipse cx="19.5" cy="31.5" rx="3.2" ry="1.6" fill="#f43f5e" opacity="0.25" />
      <ellipse cx="44.5" cy="31.5" rx="3.2" ry="1.6" fill="#f43f5e" opacity="0.25" />

      {/* Eyes: Amber Gold with glossy highlights */}
      <ellipse cx="25" cy="26" rx="4.6" ry="5.2" fill="#f59e0b" />
      <ellipse cx="25.5" cy="26" rx="2.3" ry="4.2" fill="#181820" />
      <circle cx="23.8" cy="24.2" r="1.6" fill="#ffffff" />
      <circle cx="26.4" cy="27.8" r="0.8" fill="#ffffff" />

      <ellipse cx="39" cy="26" rx="4.6" ry="5.2" fill="#f59e0b" />
      <ellipse cx="38.5" cy="26" rx="2.3" ry="4.2" fill="#181820" />
      <circle cx="37.4" cy="24.2" r="1.6" fill="#ffffff" />
      <circle cx="40" cy="27.8" r="0.8" fill="#ffffff" />

      {/* Nose & Mouth */}
      <polygon points="30.8,32.2 33.2,32.2 32,33.8" fill="#f87171" />
      <path d="M29.5 35 Q32 37.2 32 34 Q32 37.2 34.5 35" fill="none" stroke="#94a3b8" strokeWidth="1.4" strokeLinecap="round" />

      {/* Whiskers */}
      <line x1="24" y1="31.5" x2="13" y2="29.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="24" y1="34" x2="11" y2="34.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="24" y1="36.5" x2="13" y2="39.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="40" y1="31.5" x2="51" y2="29.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="40" y1="34" x2="53" y2="34.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="40" y1="36.5" x2="51" y2="39.5" stroke="#94a3b8" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
