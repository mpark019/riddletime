// Every playable character (A-Z, 0-9) has an animated image in public/images/dancing-alphabet.
export function dancingLetterSrc(character: string): string | null {
  return /^[A-Za-z0-9]$/.test(character)
    ? `/images/dancing-alphabet/dancing-${character.toLowerCase()}.gif`
    : null;
}
