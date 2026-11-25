import { z } from 'zod/v4';

const ErrorBody = z.looseObject({ message: z.string().optional() });

/** The message the worker sent with an error reply, if any. */
export const errorMessage = (data: unknown): string | undefined =>
  ErrorBody.safeParse(data).data?.message;

/** For calls whose reply isn't read. */
export const Ack = z.unknown();

// Replies are parsed so a changed shape fails here, with a message the page can
// show, instead of surfacing later as undefined fields.
export const parseBody = <S extends z.ZodType>(
  schema: S,
  data: unknown,
  fallback = 'Something went wrong. Try again.'
): z.output<S> => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(fallback);
  return parsed.data;
};

/** POSTs JSON to the worker; a failed or malformed reply throws an Error the page can show. */
export async function post<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S
): Promise<z.output<S>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorMessage(data) ?? 'Something went wrong. Try again.');
  return parseBody(schema, data);
}
