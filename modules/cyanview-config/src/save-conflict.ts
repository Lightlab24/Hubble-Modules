/** A page's save refused because another page saved the workspace after this one read it. */
export const staleDraftMessage = 'Configuration changed in another editor. Your draft is retained; refresh before saving.';
export const isStaleDraft = (error: unknown) => error instanceof Error && error.message.includes('changed in another editor');
