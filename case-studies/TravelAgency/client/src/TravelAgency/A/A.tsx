// Runtime.tsx
import React from 'react';

import * as api from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"

import * as Cancellation from './Cancellation';
import * as Roles from './Roles';
import * as Message from './Message';
import {
    State,
    ReceiveState,
    isSendState,
    isReceiveState,
    isTerminalState,
} from './EFSM';

import {
    ReceiveHandler,
    SendComponentFactory,
} from './Session';

import {
    Constructor,
    DOMEvents,
    EventHandler,
    FunctionArguments,
} from './Types';

import S19 from './S19';
import S17 from './S17';
import S13 from './S13';
import S18 from './S18';
import S15 from './S15';
import S16 from './S16';
import S14 from './S14';
import S11 from './S11';
import S12 from './S12';

type RoleToMessageQueue = Roles.PeersToMapped<any[]>;
type RoleToHandlerQueue = Roles.PeersToMapped<ReceiveHandler[]>;

// ==============
// Component type
// ==============

type Props = {
    endpoint: string,
    states: {
        S19: Constructor<S19>,
        S17: Constructor<S17>,
        S13: Constructor<S13>,
        S18: Constructor<S18>,
        S15: Constructor<S15>,
        S16: Constructor<S16>,
        S14: Constructor<S14>,
        S11: Constructor<S11>,
        S12: Constructor<S12>,

    },
    waiting: React.ReactNode,
    connectFailed: React.ReactNode,
    cancellation: (role: Roles.All, reason?: any) => React.ReactNode,
};

type Transport = {
    ws: WebSocket
};

type ComponentState = {
    elem: React.ReactNode
};

export default class Session extends React.Component<Props, Partial<Transport>> {

    constructor(props: Props) {
        super(props);
        this.state = {
            ws: undefined
        };
    }

    componentDidMount() {
        // Set up WebSocket connection
        this.setState({
            ws: new WebSocket(this.props.endpoint),
        });
    }

    render() {
        const { ws } = this.state;
        return ws === undefined
            ? this.props.waiting
            : <A ws={ws} {...this.props} />;
    }

}

class A extends React.Component<Props & Transport, ComponentState> {

    private messageQueue: RoleToMessageQueue
    private handlerQueue: RoleToHandlerQueue

    private provider : WebTracerProvider; 
    private tracer : api.Tracer;
    private backgroundSpan : api.Span;

    constructor(props: Props & Transport) {
        super(props);

        this.state = {
            elem: props.waiting,
        };

        // Set up message and handler queues
        this.messageQueue = {
            [Roles.Peers.S]: [], [Roles.Peers.B]: [],
        };
        this.handlerQueue = {
            [Roles.Peers.S]: [], [Roles.Peers.B]: [],
        };

        // Bind functions
        this.onReceiveInit = this.onReceiveInit.bind(this);
        this.onCloseInit = this.onCloseInit.bind(this);
        this.onClose = this.onClose.bind(this);
        this.onReceiveMessage = this.onReceiveMessage.bind(this);
        this.buildSendElement = this.buildSendElement.bind(this);
        this.registerReceiveHandler = this.registerReceiveHandler.bind(this);
        this.advance = this.advance.bind(this);
        this.cancel = this.cancel.bind(this);
        this.terminate = this.terminate.bind(this);

        this.provider = new WebTracerProvider({
            resource: new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: 'travel-agency'
            })
        })
        const collectorOptions = {
            url: 'http://localhost:4318/v1/traces'
        };

        const exporter = new OTLPTraceExporter(collectorOptions);
        this.provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
        this.provider.register();
        this.tracer = api.trace.getTracer('A-session');
        this.backgroundSpan = this.tracer.startSpan(Roles.Self);
    }

    componentDidMount() {
        const { ws } = this.props;
        ws.onmessage = this.onReceiveInit;

        // Send connection message
        ws.onopen = () => {
            ws.send(JSON.stringify(Message.ConnectRequest));
        };

        // Handle error
        ws.onerror = (event) => {
            this.setState({ elem: this.props.connectFailed });
        }

        ws.onclose = this.onCloseInit;
    }

    // ===============
    // Session joining
    // ===============

    private onReceiveInit(message: MessageEvent) {
        const { ws } = this.props;
        ws.onmessage = this.onReceiveMessage;
        ws.onclose = this.onClose;

        this.advance(ReceiveState.S11);

    }

    private onCloseInit({ code, wasClean, reason }: CloseEvent) {
        if (!wasClean) {
            // Not closed properly
            this.setState({ elem: this.props.connectFailed });
            return;
        }

        switch (code) {
            case Cancellation.Receive.ROLE_OCCUPIED: {
                this.processCancellation(Roles.Self, 'role occupied');
                return;
            }
            default: {
                // Unsupported code
                this.processCancellation(Roles.Server, reason);
                return;
            }
        }
    }

    // ===============
    // EFSM operations
    // ===============

    private advance(state: State) {

        if (isSendState(state)) {
            const View = this.props.states[state];
            this.setState({
                elem: <View factory={this.buildSendElement} />
            });

            return;
        }
        if (isReceiveState(state)) {
            const View = this.props.states[state];
            this.setState({
                elem: <View register={this.registerReceiveHandler} />
            });

            return;
        }

        if (isTerminalState(state)) {
            const View = this.props.states[state];
            this.backgroundSpan.end();
            this.provider.forceFlush();
            this.setState({
                elem: <View terminate={this.terminate} />
            });

            return;
        }
    }

    private buildSendElement<T>(role: Roles.Peers, label: string, successor: State): SendComponentFactory<T> {
        return <K extends keyof DOMEvents>(eventLabel: K, handler: EventHandler<T, K>) => {

            // Boolean flag since send(...) can be async;
            // must not be triggered twice.
            let used = false;

            const send = (payload: T) => this.sendMessage(role, label, payload, successor);
            const cancel = (error?: any) => this.cancel(error);

            return class extends React.Component {
                render() {
                    const props = {
                        [eventLabel as string]: (event: FunctionArguments<DOMEvents[K]>) => {
                            if (used) {
                                return;
                            }

                            used = true;

                            try {
                                const result = handler(event);
                                if (result instanceof Promise) {
                                    result.then(send).catch(cancel);
                                } else {
                                    send(result);
                                }
                            } catch (error) {
                                cancel(error);
                            }
                        }
                    };

                    return React.Children.map(this.props.children, child => (
                        React.cloneElement(child as React.ReactElement, props)
                    ));
                }
            }
        }
    }

    private registerReceiveHandler(role: Roles.Peers, handle: ReceiveHandler) {
        const message = this.messageQueue[role].shift();
        if (message !== undefined) {
            // Message received already -- process.
            try {
                const continuation = handle(message);
                if (continuation instanceof Promise) {
                    continuation.then(this.advance).catch(this.cancel);
                } else {
                    this.advance(continuation);
                }
            } catch (error) {
                this.cancel(error);
            }
        } else {
            // No message received -- `queue' handler.
            this.handlerQueue[role].push(handle);
        }
    }

    // ===============
    // Channel methods
    // ===============

    private sendMessage(role: Roles.Peers, label: string, payload: any, successor: State) {
        const ctx = api.trace.setSpan(api.context.active(), this.backgroundSpan);
        const span = this.tracer.startSpan('Send', undefined, ctx);
        span.setAttribute("mpst.action", "Send");
        span.setAttribute("mpst.msgLabel", label);
        span.setAttribute("mpst.partner", role);
        span.setAttribute("mpst.currentRole", Roles.Self);
        this.props.ws.send(JSON.stringify(Message.toChannel(role, label, payload)));
        this.advance(successor);
        span.end()
    }

    private onReceiveMessage({ data }: MessageEvent) {
        const message = JSON.parse(data) as Message.Channel;
        const handler = this.handlerQueue[message.role].shift();
        if (handler !== undefined) {
            // Handler registered -- process.
            try {
                const ctx = api.trace.setSpan(api.context.active(), this.backgroundSpan);
                const span = this.tracer.startSpan('Receive', undefined, ctx);
                span.setAttribute("mpst.action", "Recv");
                span.setAttribute("mpst.msgLabel", message.label);
                span.setAttribute("mpst.partner", message.role);
                span.setAttribute("mpst.currentRole", Roles.Self);
                const continuation = handler(data);
                if (continuation instanceof Promise) {
                    continuation.then(this.advance).catch(this.cancel);
                } else {
                    this.advance(continuation);
                }
                span.end()
            } catch (error) {
                this.cancel(error);
            }
        } else {
            // No handler registered -- `queue' message.
            this.messageQueue[message.role].push(message);
        }
    }
    private terminate() {
        this.props.ws.close(Cancellation.Emit.NORMAL);
    }

    // ============
    // Cancellation
    // ============

    private onClose({ code, reason }: CloseEvent) {
        switch (code) {
            case Cancellation.Receive.NORMAL: {
                // Normal, clean cancellation
                return;
            }
            case Cancellation.Receive.SERVER_DISCONNECT: {
                // Server role disconnected
                this.processCancellation(Roles.Server, 'server disconnected');
                return;
            }
            case Cancellation.Receive.CLIENT_DISCONNECT: {
                // Other client disconnected
                const { role, reason: description } = JSON.parse(reason) as Cancellation.Message;
                this.processCancellation(role, description);
                return;
            }
            case Cancellation.Receive.LOGICAL_ERROR: {
                // Logical error by some role
                const { role, reason: description } = JSON.parse(reason);
                this.processCancellation(role, description);
                return;
            }
            default: {
                // Unsupported error code
                this.processCancellation(Roles.Server, reason);
                return;
            }
        }
    }

    private processCancellation(role: Roles.All, reason?: any) {
        this.setState({
            elem: this.props.cancellation(role, reason !== undefined ? String(reason) : reason),
        });
    }

    private cancel(error?: any) {
        const message = Cancellation.toChannel(Roles.Self, error);

        // Emit cancellation
        this.props.ws.close(Cancellation.Emit.LOGICAL_ERROR, JSON.stringify(message));

        // Process cancellation
        this.processCancellation(Roles.Self, error);
    }

    // ============
    // UI rendering
    // ============

    render() {
        return this.state.elem;
    }

}