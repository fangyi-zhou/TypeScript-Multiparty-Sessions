// Runtime.tsx
import React from 'react';

import { State, SendState, ReceiveState, TerminalState, Roles } from './EFSM';
import {
    Constructor, ReceiveHandler,
    isSendState, isReceiveState, isTerminalState,
    SendComponentFactory,
    DOMEvents, FunctionArguments, EventHandler
} from './Session';

import S18 from './S18';
import S20 from './S20';
import S19 from './S19';

type P = {
    endpoint: string,
    states: {
        S18: Constructor<S18>,
        S20: Constructor<S20>,
        S19: Constructor<S19>,

    },
    waiting: JSX.Element
}

type S = {
    ws: WebSocket,
    elem: JSX.Element
}

export default class Alice extends React.Component<P, S> {

    private message?: any
    private handle?: ReceiveHandler

    constructor(props: P) {
        super(props);

        // Set up WebSocket
        this.state = {
            ws: new WebSocket(props.endpoint),
            elem: props.waiting,
        };

        this.message = undefined;
        this.handle = undefined;

        // Bind functions
        this.onReceiveInit = this.onReceiveInit.bind(this);
        this.onReceiveMessage = this.onReceiveMessage.bind(this);
        this.buildSendElement = this.buildSendElement.bind(this);
        this.registerReceiveHandler = this.registerReceiveHandler.bind(this);
    }

    componentDidMount() {
        this.state.ws.addEventListener('message', this.onReceiveInit);
        this.state.ws.addEventListener('open', () => this.state.ws.send(JSON.stringify({
            connect: 'Alice'
        })));
    }

    private onReceiveInit(message: MessageEvent) {
        this.state.ws.removeEventListener('message', this.onReceiveInit);
        this.state.ws.addEventListener('message', this.onReceiveMessage);

        this.advance(SendState.S18);

    }

    private advance(state: State) {
        if (isSendState(state)) {
            const View = this.props.states[state];
            this.setState({
                elem: <View factory={this.buildSendElement} />
            });
        } else if (isReceiveState(state)) {
            const View = this.props.states[state];
            this.setState({
                elem: <View register={this.registerReceiveHandler} />
            });
        } else if (isTerminalState(state)) {
            const View = this.props.states[state];
            this.setState({
                elem: <View />
            });
        }
    }

    private buildSendElement<T>(role: Roles, label: string, successor: State): SendComponentFactory<T> {
        return <K extends keyof DOMEvents>(eventLabel: K, handler: EventHandler<T, K>) => {
            const send = (payload: T) => this.sendMessage(role, label, payload, successor);

            return class extends React.Component {
                render() {
                    const children = React.Children.map(this.props.children, child => (
                        React.cloneElement(child as React.ReactElement<any>, {
                            [eventLabel as string]: (event: FunctionArguments<DOMEvents[K]>) => {
                                const result = handler(event);
                                if (result instanceof Promise) {
                                    result.then(send).catch(console.error);
                                } else {
                                    send(result);
                                }
                            }
                        })
                    ));
                    return children;
                }
            }
        }
    }

    private sendMessage(role: Roles, label: string, payload: any, successor: State) {
        this.state.ws.send(JSON.stringify({ role, label, payload }));
        this.advance(successor);
    }

    private registerReceiveHandler(handle: ReceiveHandler) {
        if (this.message !== undefined) {
            // Message received already -- process.
            const continuation = handle(this.message);
            this.message = undefined;
            if (continuation instanceof Promise) {
                continuation.then(this.advance).catch(console.error);
            } else {
                this.advance(continuation);
            }
        } else {
            // No message received -- `queue' handler.
            this.handle = handle;
        }
    }

    private onReceiveMessage(message: MessageEvent) {
        if (this.handle !== undefined) {
            // Handler registered -- process.
            const continuation = this.handle(message.data);
            this.handle = undefined;
            if (continuation instanceof Promise) {
                continuation.then(this.advance).catch(console.error);
            } else {
                this.advance(continuation);
            }
        } else {
            // No handler registered -- `queue' message.
            this.message = message;
        }
    }

    render() {
        return this.state.elem;
    }

}