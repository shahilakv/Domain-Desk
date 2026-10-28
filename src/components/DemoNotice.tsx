import { Icon } from './Icon'

const DETAILS =
  'Changes such as deletions are not saved and reset when you reload the page. Real records will appear once the database is connected.'

/**
 * Full notice on wider screens; on phones a compact one-liner that still
 * states the data is fictional, expandable for the details. CSS picks one.
 */
export function DemoNotice() {
  return (
    <>
      <div className="demo-notice demo-notice-full" role="note">
        <Icon name="info" size={18} />
        <p>
          <strong>Demo data.</strong> These clients and domains are fictional examples. {DETAILS}
        </p>
      </div>

      <details className="demo-notice demo-notice-compact">
        <summary>
          <Icon name="info" size={18} />
          <span className="demo-summary-text">
            <strong>Demo data:</strong> all records are fictional.
          </span>
          <Icon name="chevronDown" size={18} className="demo-chevron" />
        </summary>
        <p>{DETAILS}</p>
      </details>
    </>
  )
}
