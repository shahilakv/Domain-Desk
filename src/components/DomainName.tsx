import { Fragment } from 'react'

/** Renders a domain that may line-break after dots, never mid-label. */
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
          {part}
        </Fragment>
      ))}
    </>
  )
}
