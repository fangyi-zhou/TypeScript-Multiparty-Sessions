# TypeScript-Multiparty-Sessions
A toolchain for generating multiparty session type encodings in TypeScript.

## Getting Started
We provide a development environment on _Docker_, which handles Python package dependencies and the [_Scribble toolchain_](https://github.com/scribble/scribble-java/).

### Setup DevEnv
```bash
# Make scripts executable
chmod +x build.sh
chmod +x start.sh

# Build Docker image
./build.sh
```

### Enter DevEnv
```bash
# Starts interactive shell inside the Docker container
./start.sh

# To leave the development environment:
exit
```

## Usage
```bash
python3.7 -m mpst_ts <filename> <protocol> <role> {node,browser}
```