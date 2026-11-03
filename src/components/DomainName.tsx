import { Fragment } from 'react'

/** Renders a label that may line-break after its hyphens (e.g. "acme-trading-"). */
function Label({ text }: { text: string }) {
  const parts = text.split('-')
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              -<wbr />
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Renders a domain that may line-break after dots or hyphens, never elsewhere,
 * so long hyphenated names fit narrow table columns.
 */
export function DomainName({ name }: { name: string }) {
  const parts = name.split('.')
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              .<wbr />
            </>
          )}
          <Label text={part} />
        </Fragment>
      ))}
    </>
  )
}
