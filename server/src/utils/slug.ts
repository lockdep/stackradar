/**
 * Generate a URL-safe slug from a string
 */
function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove non-word chars
    .replace(/[\s_-]+/g, "-") // Replace spaces and underscores with hyphens
    .replace(/^-+|-+$/g, ""); // Remove leading/trailing hyphens
}

/**
 * Generate a unique slug by appending a random suffix if needed
 */
export function generateUniqueSlug(text: string): string {
  const baseSlug = generateSlug(text);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${baseSlug}-${suffix}`;
}

