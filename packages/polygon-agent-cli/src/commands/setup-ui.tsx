import { ethers } from 'ethers';
import { Box, Text, useApp } from 'ink';
import React, { useState, useEffect } from 'react';

import { getAuthToken, createProject, getDefaultAccessKey } from '../lib/builder-api.ts';
import { generateEthAuthProof } from '../lib/ethauth.ts';
import { saveBuilderConfig, loadBuilderConfig } from '../lib/storage.ts';
import { Header, Step, KV, Hint, Err } from '../ui/components.js';

// Re-export API helpers used by setup.ts
export { getAuthToken, createProject, getDefaultAccessKey } from '../lib/builder-api.ts';

type Phase =
  | 'checking'
  | 'generating'
  | 'authenticating'
  | 'creating'
  | 'done'
  | 'existing'
  | 'error';

export function SetupUI({ name, force }: { name: string; force: boolean }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('checking');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const existing = await loadBuilderConfig();
        if (existing && !force) {
          setResult(existing);
          setPhase('existing');
          exit();
          return;
        }
        setPhase('generating');
        const wallet = ethers.Wallet.createRandom();
        const privateKey = wallet.privateKey;
        const eoaAddress = wallet.address;
        setPhase('authenticating');
        const ethAuthProof = await generateEthAuthProof(privateKey);
        const jwtToken = await getAuthToken(ethAuthProof);
        setPhase('creating');
        const project = await createProject(name, jwtToken);
        const accessKey = await getDefaultAccessKey(project.id, jwtToken);
        await saveBuilderConfig({ privateKey, eoaAddress, accessKey, projectId: project.id });
        setResult({ eoaAddress, accessKey, projectId: project.id });
        setPhase('done');
        exit();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('error');
        exit(new Error(msg));
      }
    })();
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Header />
      <Step label="Check existing config" status={phase === 'checking' ? 'active' : 'done'} />
      <Step
        label="Generate keys"
        status={
          phase === 'checking'
            ? 'pending'
            : phase === 'generating'
              ? 'active'
              : ['authenticating', 'creating', 'done', 'existing'].includes(phase)
                ? 'done'
                : 'pending'
        }
      />
      <Step
        label="Authenticate"
        status={
          ['checking', 'generating'].includes(phase)
            ? 'pending'
            : phase === 'authenticating'
              ? 'active'
              : ['creating', 'done'].includes(phase)
                ? 'done'
                : 'pending'
        }
      />
      <Step
        label="Create project"
        status={
          ['checking', 'generating', 'authenticating'].includes(phase)
            ? 'pending'
            : phase === 'creating'
              ? 'active'
              : phase === 'done'
                ? 'done'
                : 'pending'
        }
      />

      {phase === 'done' && result && (
        <Box flexDirection="column" marginTop={1}>
          <KV k="address" v={`${result.eoaAddress.slice(0, 6)}···${result.eoaAddress.slice(-4)}`} />
          <KV k="key" v={`${result.accessKey.slice(0, 12)}···`} />
          <KV k="project" v={String(result.projectId)} />
          <Hint>Next: agent wallet login</Hint>
        </Box>
      )}
      {phase === 'existing' && result && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Already configured</Text>
          <KV k="address" v={`${result.eoaAddress.slice(0, 6)}···${result.eoaAddress.slice(-4)}`} />
          <Hint>Next: agent wallet login</Hint>
        </Box>
      )}
      {phase === 'error' && <Err message={error} />}
    </Box>
  );
}
