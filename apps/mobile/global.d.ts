// @types/react 19 dropped the global `JSX` namespace in favour of `React.JSX`.
// Our components annotate returns as `JSX.Element`, so re-expose the global
// namespace as an alias of React.JSX. (Safe: React 19 types no longer declare a
// global JSX, so there's nothing to clash with.)
import type * as React from 'react'

declare global {
  namespace JSX {
    type Element = React.JSX.Element
    type ElementType = React.JSX.ElementType
    type ElementClass = React.JSX.ElementClass
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>
    interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
  }
}
