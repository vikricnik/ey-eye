/** A test result's key: its case and variant. Its own module so pure code
 * (ui/sectionSummaries.ts) can use it without loading the Tests view. */
export const resultKey = (testCase: string, variant: string) => `${testCase}\u0000${variant}`;
