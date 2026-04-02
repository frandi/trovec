import { CliError } from '../errors.js';
import type { CliFlags } from '../config.js';

const COMMANDS = [
  'init', 'add', 'add-many', 'get', 'delete', 'search', 'query',
  'find', 'stats', 'flush', 'embed', 'import', 'export', 'inspect',
  'config', 'repl', 'completions',
];

export async function completionsCommand(positionals: string[], _flags: CliFlags): Promise<void> {
  const shell = positionals[0];

  switch (shell) {
    case 'bash':
      process.stdout.write(bashCompletions());
      break;
    case 'zsh':
      process.stdout.write(zshCompletions());
      break;
    case 'fish':
      process.stdout.write(fishCompletions());
      break;
    default:
      throw new CliError(
        shell ? `Unsupported shell "${shell}".` : 'Shell argument is required.',
        'Supported: bash, zsh, fish. Usage: trovec completions bash',
      );
  }
}

function bashCompletions(): string {
  return `# trovec bash completions
# Add to ~/.bashrc: eval "$(trovec completions bash)"
_trovec() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${COMMANDS.join(' ')}"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "$prev" in
    --embedder)
      COMPREPLY=( $(compgen -W "local openai ollama" -- "$cur") )
      return 0
      ;;
    --quantization)
      COMPREPLY=( $(compgen -W "F32 INT8 BIT" -- "$cur") )
      return 0
      ;;
    --metric)
      COMPREPLY=( $(compgen -W "cosine euclidean dot hamming" -- "$cur") )
      return 0
      ;;
    --format)
      COMPREPLY=( $(compgen -W "table json jsonl csv" -- "$cur") )
      return 0
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    local opts="--dir --collection --format --quiet --help --version"
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi
}
complete -F _trovec trovec
`;
}

function zshCompletions(): string {
  return `# trovec zsh completions
# Add to ~/.zshrc: eval "$(trovec completions zsh)"
_trovec() {
  local -a commands
  commands=(
    ${COMMANDS.map((c) => `'${c}:${c} command'`).join('\n    ')}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::options:->options'

  case $state in
    command)
      _describe 'command' commands
      ;;
    options)
      case $words[1] in
        init)
          _arguments \\
            '--dimensions[Vector dimensions]:dimensions:' \\
            '--quantization[Quantization type]:type:(F32 INT8 BIT)' \\
            '--metric[Distance metric]:metric:(cosine euclidean dot hamming)' \\
            '--embedder[Embedder]:embedder:(local openai ollama)'
          ;;
        *)
          _arguments \\
            '--dir[Storage directory]:dir:_directories' \\
            '--collection[Collection ID]:collection:' \\
            '--format[Output format]:format:(table json jsonl csv)' \\
            '--quiet[Suppress status messages]' \\
            '--help[Show help]'
          ;;
      esac
      ;;
  esac
}
compdef _trovec trovec
`;
}

function fishCompletions(): string {
  const cmds = COMMANDS.map((c) =>
    `complete -c trovec -n "__fish_use_subcommand" -a "${c}" -d "${c}"`,
  ).join('\n');

  return `# trovec fish completions
# Add to ~/.config/fish/completions/trovec.fish
${cmds}
complete -c trovec -l dir -d "Storage directory" -r
complete -c trovec -l collection -d "Collection ID" -r
complete -c trovec -l format -d "Output format" -r -a "table json jsonl csv"
complete -c trovec -l quiet -d "Suppress status messages"
complete -c trovec -l help -d "Show help"
complete -c trovec -l version -d "Show version"
complete -c trovec -n "__fish_seen_subcommand_from init" -l embedder -r -a "local openai ollama"
complete -c trovec -n "__fish_seen_subcommand_from init" -l quantization -r -a "F32 INT8 BIT"
complete -c trovec -n "__fish_seen_subcommand_from init" -l metric -r -a "cosine euclidean dot hamming"
complete -c trovec -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"
`;
}
