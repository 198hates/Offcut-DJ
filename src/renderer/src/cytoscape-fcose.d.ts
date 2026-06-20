// cytoscape-fcose ships no type declarations; it's a Cytoscape layout extension
// registered via cytoscape.use(). The fcose-specific layout options (nodeRepulsion,
// idealEdgeLength, fixedNodeConstraint, …) are passed through cy.layout() and cast
// at the call site.
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape'
  const fcose: Ext
  export default fcose
}
