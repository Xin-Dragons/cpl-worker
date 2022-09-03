import { getPrograms, subscribeToProgram } from '../helpers';

async function runProgram(program) {
  try {
    console.log(`Polling ${program.name}`)

    await subscribeToProgram(program)

  } catch (err) {
    console.log(err)
    runProgram(program)
  }

}

export async function run() {
  const programs = await getPrograms();

  await Promise.all(programs.map(runProgram));
}
