import WebSocket from "ws";
import { v1 as uuidv1 } from "uuid";

import * as Cancellation from "./Cancellation";

import * as opentelemetry from "@opentelemetry/sdk-node";
import * as api from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";

import {
    Message,
    Role,
    State,
} from "./EFSM";

// =============
// Runtime Types
// =============

type StateInitialiser<SessionID> = (sessionID: SessionID) => State.S38;

export type StateTransitionHandler = (state: State.Type) => void;
export type SendStateHandler = (role: Role.Peers, label: string, payload: any[]) => void;
export type MessageHandler = (payload: any) => void;
export type ReceiveStateHandler = (from: Role.Peers, messageHandler: MessageHandler) => void;

// ===============
// WebSocket Types
// ===============

type RoleToSocket = Role.PeersToMapped<WebSocket>;
type RoleToMessageQueue = Role.PeersToMapped<any[]>;
type RoleToHandlerQueue = Role.PeersToMapped<MessageHandler[]>;

interface WebSocketMessage {
    data: any
    type: string
    target: WebSocket
};

type ConnectionContext = [Set<Role.Peers>, Partial<RoleToSocket>, Map<WebSocket, Role.Peers>]

// ================
// Connection Phase
// ================

namespace Connect {
    export interface Request {
        connect: Role.Peers;
    };

    export const Confirm = {
        connected: true,
    };
};

// Factory function to create a new connection context to keep track
// of pending connections before instantiating a session.
const makeNewContext = (): ConnectionContext => {
    // Keep track of participants that have yet to join.
    const waiting: Set<Role.Peers> = new Set([Role.Peers.A, Role.Peers.B]);

    // Keep track of mapping between role and WebSocket.
    const roleToSocket: Partial<RoleToSocket> = {
        [Role.Peers.A]: undefined, [Role.Peers.B]: undefined,
    };
    const socketToRole = new Map<WebSocket, Role.Peers>();

    return [waiting, roleToSocket, socketToRole];
};

export class S {
    constructor(wss: WebSocket.Server,
        cancellation: Cancellation.Handler<string>,
        initialise: StateInitialiser<string>,
        generateID: () => string = uuidv1) {

        const connectionContexts: ConnectionContext[] = [];

        // Handle explicit cancellation during the join phase.
        const onClose = ({ target: socket }: WebSocket.CloseEvent) => {
            socket.removeAllListeners();

            // Wait for the role again - guaranteed to occur in map by construction.
            for (const [waiting, roleToSocket, socketToRole] of connectionContexts) {
                const role = socketToRole.get(socket);
                if (role !== undefined) {
                    waiting.add(role);
                }
            }
        }

        // Handle connection invitation message from participant.
        const onSubscribe = (event: WebSocketMessage) => {
            const { data, target: socket } = event;
            const { connect: role } = Message.deserialise<Connect.Request>(data);

            for (const [waiting, roleToSocket, socketToRole] of connectionContexts) {
                if (waiting.has(role)) {
                    // Update role-WebSocket mapping.
                    roleToSocket[role] = socket;
                    socketToRole.set(socket, role);
                    waiting.delete(role);

                    if (waiting.size === 0) {
                        connectionContexts.shift();

                        // Execute protocol when all participants have joined.
                        new Session(
                            generateID(),
                            wss,
                            roleToSocket as RoleToSocket,
                            cancellation,
                            initialise
                        );
                    }
                    return;
                }
            }

            // Role occupied in all existing connection contexts;
            // Create new connection context.
            const context = makeNewContext();
            const [waiting, roleToSocket, socketToRole] = context;

            // Update role-WebSocket mapping.
            roleToSocket[role] = socket;
            socketToRole.set(socket, role);
            waiting.delete(role);

            connectionContexts.push(context);
        }

        // Bind event listeners for every new connection.
        wss.addListener('connection', (ws: WebSocket) => {
            ws.onmessage = onSubscribe;
            ws.onclose = onClose;
        });

    }

}

class Session {

    private id: string;
    private wss: WebSocket.Server;
    private roleToSocket: RoleToSocket;
    private cancellation: Cancellation.Handler<string>;
    private initialise: StateInitialiser<string>;

    private activeRoles: Set<Role.Peers>;
    private messageQueue: RoleToMessageQueue;
    private handlerQueue: RoleToHandlerQueue;

    private provider = new BasicTracerProvider({
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: 'travel-agency'
        })
    })
    private tracer = api.trace.getTracer('server-session');
    private backgroundSpan : opentelemetry.api.Span;


    constructor(id: string,
        wss: WebSocket.Server,
        roleToSocket: RoleToSocket,
        cancellation: Cancellation.Handler<string>,
        initialise: StateInitialiser<string>) {
        this.id = id;
        this.wss = wss;
        this.roleToSocket = roleToSocket;
        this.cancellation = cancellation;
        this.initialise = initialise;

        // Keep track of active participants in the session.
        this.activeRoles = new Set([Role.Peers.B, Role.Peers.A]);

        // Bind `this` instances to callbacks
        this.next = this.next.bind(this);
        this.cancel = this.cancel.bind(this);
        this.send = this.send.bind(this);
        this.registerMessageHandler = this.registerMessageHandler.bind(this);

        // Bind event listeners to WebSockets
        Object.values(Role.Peers).forEach(role => {
            const socket = this.roleToSocket[role];

            // Bind handlers for message receive and socket close.
            socket.onmessage = this.receive(role).bind(this);
            socket.onclose = this.close(role).bind(this);
        });

        // Initialise queues for receiving.
        this.messageQueue = {
            [Role.Peers.B]: [], [Role.Peers.A]: [],
        };

        this.handlerQueue = {
            [Role.Peers.B]: [], [Role.Peers.A]: [],
        };

        // Notify all roles for confirming the connection.
        Object.values(this.roleToSocket).forEach(socket => {
            socket.send(Message.serialise(Connect.Confirm));
        });

        const collectorOptions = {
            url: 'localhost:30080'
        };

        const exporter = new OTLPTraceExporter(collectorOptions);
        this.provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
        this.provider.register();
        this.backgroundSpan = this.tracer.startSpan(Role.Self);

        this.next(initialise(this.id));
    }

    // ===================
    // Transition function
    // ===================

    next(state: State.Type) {
        switch (state.type) {
            case 'Send':
                return state.performSend(this.next, this.cancel, this.send);
            case 'Receive':
                return state.prepareReceive(this.next, this.cancel, this.registerMessageHandler);
            case 'Terminal':
                this.backgroundSpan.end();
                this.provider.forceFlush();
                return;
        }
    }

    // ===============
    // Channel methods
    // ===============

    send(to: Role.Peers, label: string, payload: any[], from: Role.All = Role.Self) {
        let span;
        if (from === Role.Self) {
            const ctx = opentelemetry.api.trace.setSpan(opentelemetry.api.context.active(), this.backgroundSpan);
            span = this.tracer.startSpan('Send', undefined, ctx);
            span.setAttribute("mpst.action", "Send");
            span.setAttribute("mpst.msgLabel", label);
            span.setAttribute("mpst.partner", to);
            span.setAttribute("mpst.currentRole", from);
        }
        const message = Message.serialise<Message.Channel>({ role: from, label, payload });
        const onError = (error?: Error) => {
            if (error !== undefined) {

                // Only flag an error if the recipient is meant to be active,
                // and the message cannot be sent.
                if (this.activeRoles.has(to)) {
                    throw new Error(`Cannot send to role: ${to}`);
                }

            }
        };
        this.roleToSocket[to].send(message, onError);
        if (span !== undefined) {
            span.end()
        }
    }

    receive(from: Role.Peers) {
        return ({ data }: WebSocketMessage) => {
            const { role, label, payload } = Message.deserialise<Message.Channel>(data);
            if (role !== Role.Self) {
                // Route message
                this.send(role, label, payload, from);
            } else {
                const ctx = opentelemetry.api.trace.setSpan(opentelemetry.api.context.active(), this.backgroundSpan);
                const span = this.tracer.startSpan('Receive', undefined, ctx);
                span.setAttribute("mpst.action", "Recv");
                span.setAttribute("mpst.msgLabel", label);
                span.setAttribute("mpst.partner", from);
                span.setAttribute("mpst.currentRole", role);
                const handler = this.handlerQueue[from].shift();
                if (handler !== undefined) {
                    handler(data);
                } else {
                    this.messageQueue[from].push(data);
                }
                span.end()
            }
        }
    }

    registerMessageHandler(from: Role.Peers, messageHandler: MessageHandler) {
        const message = this.messageQueue[from].shift();
        if (message !== undefined) {
            messageHandler(message);
        } else {
            this.handlerQueue[from].push(messageHandler);
        }
    }

    // ============
    // Cancellation
    // ============

    cancel(reason?: any) {
        // Deactivate all roles as the session is cancelled.
        this.activeRoles.clear();

        // Emit cancellation to other roles.
        const message = Cancellation.toChannel(Role.Self, reason);
        Object.values(this.roleToSocket)
            .forEach(socket => {
                socket.removeAllListeners();
                socket.close(Cancellation.Emit.LOGICAL_ERROR, JSON.stringify(message));
            });

        // Execute user-defined cancellation handler.
        this.cancellation(this.id, Role.Self, reason);
    }

    propagateCancellation(cancelledRole: Role.Peers, reason?: any) {
        // Deactivate all roles as the session is cancelled.
        this.activeRoles.clear();

        // Emit cancellation to other roles.
        const message = Cancellation.toChannel(cancelledRole, reason);
        Object.entries(this.roleToSocket)
            .filter(([role, _]) => role !== cancelledRole)
            .forEach(([_, socket]) => {
                socket.removeAllListeners();
                socket.close(Cancellation.Emit.LOGICAL_ERROR, JSON.stringify(message));
            });

        // Execute user-defined cancellation handler.
        this.cancellation(this.id, cancelledRole, reason);
    }

    close(role: Role.Peers) {
        return ({ target: socket, code, reason }: WebSocket.CloseEvent) => {
            this.activeRoles.delete(role);
            switch (code) {
                case Cancellation.Receive.NORMAL: {
                    // Unsubscribe from socket events.
                    socket.removeAllListeners();
                    return;
                }
                case Cancellation.Receive.CLIENT_BROWSER_CLOSED: {
                    // Client closed their browser
                    this.propagateCancellation(role, 'browser disconnected');
                    return;
                }
                case Cancellation.Receive.LOGICAL_ERROR: {
                    // Client has logical error
                    this.propagateCancellation(role, reason);
                    return;
                }
                default: {
                    // Unsupported code
                    this.propagateCancellation(role, reason);
                    return;
                }
            }
        }
    }

}
