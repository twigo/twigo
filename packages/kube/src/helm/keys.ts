/** The context keys a release's page sets, which its commands read. */
/** The view the page shows: one of its tabs, or `defaults` for the chart's defaults. */
export const HELM_TAB = "helm.tab";
export const HELM_REVISION = "helm.revision";
/** The highest revision Helm keeps below the one shown, empty where it keeps none. */
export const HELM_PREVIOUS = "helm.previous";
/** Set where no CLI command prints the view the page shows. */
export const HELM_NO_COMMAND = "helm.noCommand";
