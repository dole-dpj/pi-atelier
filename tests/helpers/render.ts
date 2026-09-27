export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
};

export function requiredRow(lines: readonly string[], label: string): string {
	const row = lines.find((line) => line.includes(label));
	if (row === undefined) throw new Error(`Missing rendered row: ${label}`);
	return row;
}

export function requiredIndex(lines: readonly string[], label: string): number {
	const index = lines.findIndex((line) => line.includes(label));
	if (index < 0) throw new Error(`Missing rendered row: ${label}`);
	return index;
}
