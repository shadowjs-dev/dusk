/**
 * The root component of the app. It receives the routed page as `children` and renders it inside
 * its own layout. Declared with a `never` parameter, like route components, so a component typed
 * with any props shape is accepted: `(props: { children?: JSX.Element })`, `()` or
 * `(props: { children?: JSX.Element; title: string })`. The server manifest (`App`) and
 * `hydrateDusk({ App })` take the same shape, so one component serves both.
 * @since 1.0.0
 */
export type AppComponent = (props: never) => unknown;
