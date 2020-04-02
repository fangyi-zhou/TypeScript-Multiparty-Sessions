from argparse import ArgumentParser
import os
import sys
import typing

import mpst_ts.codegen as codegen
import mpst_ts.codegen.generator as generator
import mpst_ts.scribble as scribble

def get_argument_parser() -> ArgumentParser:
    parser = ArgumentParser()

    supported_targets = generator.utils.CodeGenerationStrategy.target_to_strategy.keys()

    parser.add_argument('filename', type=str, help='Path to Scribble protocol')
    parser.add_argument('protocol', type=str, help='Name of protocol')
    parser.add_argument('role', type=str, help='Role to project')
    parser.add_argument('target', choices=supported_targets, help='Code generation target')

    return parser

def main(args: typing.List[str]) -> int:
    parser = get_argument_parser()
    parsed_args = parser.parse_args()

    return_code, output = scribble.get_graph(parsed_args.filename, parsed_args.protocol, parsed_args.role)
    if return_code:
        print(output, file=sys.stderr)
        return return_code

    efsm = codegen.parse.from_data(output,
                                   protocol=parsed_args.protocol,
                                   role=parsed_args.role)

    code_generator = generator.CodeGenerator(target=parsed_args.target)
    code_generator.generate(efsm)

    return 0

sys.exit(main(sys.argv[1:]))