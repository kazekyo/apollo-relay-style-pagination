/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { ApolloCache, ApolloLink, Reference, StoreObject, TypePolicy } from '@apollo/client';
import { DocumentNode, visit } from 'graphql/language';
import isMatch from 'lodash.ismatch';
import { encode, decode } from 'js-base64';

type ConnectionInfo = {
  id: string;
  field: string;
  keyArgs?: Record<string, unknown>;
};

const DIRECTIVE_NAMES = ['appendNode', 'prependNode', 'deleteRecord'];

const transform = (input: DocumentNode) => {
  // TODO : Run only for mutation
  const isQueryOperation = input.definitions.some(element => {
    return element.kind === 'OperationDefinition' && element.operation === 'query' ? true : false;
  });

  if (isQueryOperation === true) {
    return input;
  } else {
    return visit(input, {
      OperationDefinition: {
        enter(node) {
        }
      },
      VariableDefinition: {
        enter(node) {
          if (node.variable.name.value === 'connections') {
            return null;
          }
          if (node.variable.name.value === 'edgeTypeName') {
            return null;
          }
        },
        leave(node) {
          return node;
        }
      },
      Directive: {
        enter(node) {
          if (DIRECTIVE_NAMES.includes(node.name.value)) {
            return null;
          }
        }
      },
    });
  }
};

export const createMutationUpdaterLink = (): ApolloLink => {
  return new ApolloLink((operation, forward) => {
    operation.query = transform(operation.query);
    // TODO : Consider subscriptions
    // https://github.com/cult-of-coders/apollo-client-transformers/blob/master/src/index.ts
    return forward(operation).map(({ data, ...response }) => {
      return { ...response, data };
    });
  });
};

const insertNode = <T>({
  cache,
  nodeRef,
  connectionId,
  edgeTypeName,
  type,
}: {
  cache: ApolloCache<T>;
  nodeRef: Reference;
  connectionId: string;
  edgeTypeName: string;
  type: string;
}) => {
  const connectionInfo = JSON.parse(decode(connectionId)) as ConnectionInfo;
  cache.modify({
    id: connectionInfo.id,
    fields: {
      [connectionInfo.field]: (
        existingConnection: StoreObject & {
          edges: StoreObject[];
          args?: Record<string, unknown>;
        },
      ) => {
        if (
          existingConnection.args &&
          connectionInfo.keyArgs &&
          !isMatch(existingConnection.args, connectionInfo.keyArgs)
        ) {
          return { ...existingConnection };
        }
        const newEdge = { __typename: edgeTypeName, node: nodeRef, cursor: '' };
        const edges =
          type === 'appendNode' ? [...existingConnection.edges, newEdge] : [newEdge, ...existingConnection.edges];
        return {
          ...existingConnection,
          edges,
        };
      },
    },
  });
};

export const mutationUpdater = (): TypePolicy => {
  return {
    merge(existing: Reference, incoming: Reference, { cache, field, storeFieldName }) {
      const result = { ...existing, ...incoming };
      const directiveName = field?.directives?.find((directive) => DIRECTIVE_NAMES.includes(directive.name.value))?.name
        .value;
      if (!directiveName) return result;

      if (directiveName == 'deleteRecord') {
        const cacheId = cache.identify(result);
        cache.evict({ id: cacheId });
      } else {
        const connectionsStr = /"connections":(?<connections>\[[^\].]+\])/.exec(storeFieldName)?.groups?.connections;
        const connections = connectionsStr && (JSON.parse(connectionsStr) as string[]);
        const edgeTypeName = /"edgeTypeName":[^"]*"(?<edgeTypeName>.+)"/.exec(storeFieldName)?.groups?.edgeTypeName;
        if (!connections || !edgeTypeName) return result;
        connections.forEach((connectionId) =>
          insertNode({ cache, nodeRef: incoming, connectionId, edgeTypeName, type: directiveName }),
        );
      }

      return result;
    },
  };
};

export const generateConnectionId = (connectionInfo: ConnectionInfo): string => encode(JSON.stringify(connectionInfo));
